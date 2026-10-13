import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  idem: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  repoOk: true,
  claim: vi.fn(),
  review: vi.fn(),
  test: vi.fn(),
  candidates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    reviewAgentIdempotency: {
      findUnique: async ({ where }: { where: { tokenId_idemKey: { tokenId: string; idemKey: string } } }) =>
        m.idem.find((r) => r.tokenId === where.tokenId_idemKey.tokenId && r.idemKey === where.tokenId_idemKey.idemKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (m.idem.some((r) => r.tokenId === data.tokenId && r.idemKey === data.idemKey)) throw new Error("unique");
        m.idem.push({ ...data, response: null });
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        m.idem.filter((r) => r.tokenId === where.tokenId && r.idemKey === where.idemKey).forEach((r) => Object.assign(r, data));
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        m.idem = m.idem.filter((r) => !(r.tokenId === where.tokenId && r.idemKey === where.idemKey));
      },
    },
    reviewAgentAuditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void m.audits.push(data) },
    reviewAgentToken: { updateMany: async () => ({ count: 1 }) },
    repository: { findFirst: async () => (m.repoOk ? { id: "r" } : null) },
    releaseCandidate: { findMany: async () => m.candidates },
  },
}));
vi.mock("@/lib/release-fix-internal-run", () => ({
  claimInternalSession: m.claim,
  recordInternalReview: m.review,
  recordInternalTest: m.test,
  releaseInternalSession: vi.fn(),
  pauseInternalByReport: vi.fn(),
  resumeInternal: vi.fn(),
  loadInternalViewForUi: vi.fn(),
}));
vi.mock("@/lib/release-verification", () => ({ listReleaseVerificationDetails: vi.fn(async () => []) }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: vi.fn() }));

import type { ReviewAgentPrincipal } from "@/lib/review-agent/auth";
import { callReviewAgentTool, listReviewAgentTools, pageOf } from "@/lib/review-agent/service";

const principal = (over: Partial<ReviewAgentPrincipal> = {}): ReviewAgentPrincipal => ({
  tokenId: "tokA",
  userId: "u1",
  name: "n",
  scopes: ["read", "write", "resume"],
  repositories: ["o/r"],
  ...over,
});
const SHA = "a".repeat(40);
const base = { repository: "o/r", issue: 10, agent: "agentA" };

beforeEach(() => {
  vi.clearAllMocks();
  m.idem = [];
  m.audits = [];
  m.repoOk = true;
  m.candidates = [];
  m.claim.mockResolvedValue({ ok: true, epoch: 1, handover: false, status: { assignee: { epoch: 1 } } });
});

describe("認可", () => {
  it("読み取り専用トークンは更新できず、拒否が監査に残る", async () => {
    const r = await callReviewAgentTool(principal({ scopes: ["read"] }), "claim_fix", { ...base, idempotencyKey: "key-0000001" });
    expect(r).toMatchObject({ ok: false, status: 403, error: "scope_not_allowed" });
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.audits).toEqual([expect.objectContaining({ tool: "claim_fix", outcome: "denied", tokenId: "tokA", errorCode: "scope_not_allowed" })]);
  });
  it("許可リスト外のrepositoryは取得も更新も拒否する", async () => {
    const read = await callReviewAgentTool(principal(), "list_release_candidates", { repository: "o/other" });
    expect(read).toMatchObject({ ok: false, status: 403, error: "repository_not_allowed" });
    const write = await callReviewAgentTool(principal(), "claim_fix", { ...base, repository: "o/other", idempotencyKey: "key-0000001" });
    expect(write).toMatchObject({ ok: false, status: 403, error: "repository_not_allowed" });
    expect(m.claim).not.toHaveBeenCalled();
  });
  it("発行者の連携が外れたrepositoryは404", async () => {
    m.repoOk = false;
    expect(await callReviewAgentTool(principal(), "list_release_candidates", { repository: "o/r" })).toMatchObject({ ok: false, status: 404, error: "repository_not_found" });
  });
  it("未知のツールは404", async () => {
    expect(await callReviewAgentTool(principal(), "drop_table", {})).toMatchObject({ ok: false, status: 404 });
  });
});

describe("読み取りは副作用なし", () => {
  it("成功した取得は監査にも冪等テーブルにも書かない", async () => {
    const r = await callReviewAgentTool(principal(), "list_release_candidates", { repository: "o/r" });
    expect(r).toMatchObject({ ok: true });
    expect(m.audits).toHaveLength(0);
    expect(m.idem).toHaveLength(0);
  });
  it("一覧は件数を超える分をnextCursorで示す", async () => {
    m.candidates = [3, 2, 1].map((sequence) => ({ sequence, phase: "x", activeKey: null, currentRevision: 0, frozenDevelopSha: SHA, cancelledAt: null, cancelReason: null, createdAt: new Date(), revisions: [] }));
    const r = await callReviewAgentTool(principal(), "list_release_candidates", { repository: "o/r", limit: 2 });
    expect(r.ok && (r.data as { page: unknown }).page).toEqual({ limit: 2, hasMore: true, nextCursor: 2 });
  });
});

describe("更新の冪等性", () => {
  it("同じキー・同じ内容の再送は保存した結果を返し、二重に実行しない", async () => {
    const a = await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000001" });
    const b = await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000001" });
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true, replayed: true, data: { epoch: 1 } });
    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.audits.filter((x) => x.outcome === "ok")).toHaveLength(2); // 再送も受け付けた事実として監査に残る
  });
  it("同じキーで内容が違えば拒否する", async () => {
    await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000001" });
    const r = await callReviewAgentTool(principal(), "claim_fix", { ...base, takeover: true, idempotencyKey: "key-0000001" });
    expect(r).toMatchObject({ ok: false, status: 409, error: "idempotency_conflict" });
    expect(m.claim).toHaveBeenCalledTimes(1);
  });
  it("実行中の再送はin_progress。拒否された操作は保存せず、取り直して同じキーで再送できる", async () => {
    m.idem.push({ tokenId: "tokA", idemKey: "key-0000002", tool: "claim_fix", requestHash: "x", response: null });
    expect(await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000002" })).toMatchObject({ ok: false, error: "idempotency_conflict" });
    m.claim.mockResolvedValueOnce({ ok: false, error: "lease_held", message: "別の担当" });
    const first = await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000003" });
    expect(first).toMatchObject({ ok: false, status: 409, error: "lease_held", refetchRequired: true });
    const retry = await callReviewAgentTool(principal(), "claim_fix", { ...base, idempotencyKey: "key-0000003" });
    expect(retry).toMatchObject({ ok: true });
  });
  it("idempotencyKeyが無い更新は400", async () => {
    expect(await callReviewAgentTool(principal(), "claim_fix", base)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("報告の検証", () => {
  it("テスト報告は検証したSHAを渡し、旧SHAは再取得が必要な理由つきで返す", async () => {
    m.test.mockResolvedValueOnce({ ok: false, error: "stale_sha", message: "旧SHA", currentSha: "b".repeat(40) });
    const r = await callReviewAgentTool(principal(), "report_fix_test", { ...base, epoch: 1, sha: SHA, state: "passed", idempotencyKey: "key-0000004" });
    expect(r).toMatchObject({ ok: false, status: 409, error: "stale_sha", refetchRequired: true, details: { currentSha: "b".repeat(40) } });
    expect(m.test).toHaveBeenCalledWith(expect.objectContaining({ expectedSha: SHA, actor: { assignee: "ext:tokA:agentA", epoch: 1 } }));
  });
  it("shaが無い・不正な報告は受け付けない", async () => {
    const r = await callReviewAgentTool(principal(), "report_fix_test", { ...base, epoch: 1, sha: "abc", state: "passed", idempotencyKey: "key-0000005" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(m.test).not.toHaveBeenCalled();
  });
  it("独立レビューは報告主体としてトークンを渡し、解消の根拠が空なら拒否する", async () => {
    m.review.mockResolvedValue({ ok: true, round: 1, status: {} });
    const bad = await callReviewAgentTool(principal({ tokenId: "tokB" }), "report_fix_review", { ...base, epoch: 1, sha: SHA, verdict: "pass", resolved: [{ key: "F-001", resolution: " " }], idempotencyKey: "key-0000006" });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const good = await callReviewAgentTool(principal({ tokenId: "tokB" }), "report_fix_review", { ...base, epoch: 1, sha: SHA, verdict: "pass", resolved: [{ key: "F-001", resolution: "確認済み" }], idempotencyKey: "key-0000007" });
    expect(good).toMatchObject({ ok: true });
    const call = m.review.mock.calls[0][0];
    expect(call.expectedSha).toBe(SHA);
    expect(call.actor).toEqual({ assignee: "ext:tokB:agentA", epoch: 1, reviewer: true });
    expect(call.reviewer.ref).toBe("ext:tokB:agentA");
    expect(call.reviewer.isSelf("ext:tokB:x")).toBe(true);
    expect(call.reviewer.isSelf("ext:tokA:x")).toBe(false);
  });
});

describe("ページングと公開範囲", () => {
  it("切り捨てた分は件数と次の位置で明示する", () => {
    expect(pageOf([1, 2, 3, 4, 5], 0, 2)).toEqual({ items: [1, 2], total: 5, offset: 0, limit: 2, nextOffset: 2, truncated: true });
    expect(pageOf([1, 2, 3], 2, 2)).toMatchObject({ items: [3], nextOffset: null, truncated: false });
  });
  it("公開するツールは決まった取得・更新だけ（任意SQL・テーブル操作は無い）", () => {
    expect(listReviewAgentTools().map((t) => t.name)).toEqual(["list_release_candidates", "get_release_candidate", "get_fix_status", "claim_fix", "release_fix", "pause_fix", "resume_fix", "report_fix_test", "report_fix_review"]);
  });
});
