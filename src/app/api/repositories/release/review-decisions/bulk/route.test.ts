import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findRepository = vi.fn();
const fetchPullRequest = vi.fn();
const createIssue = vi.fn();
const loadSummary = vi.fn();
const saveDecision = vi.fn();
const findRecommendation = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: (...a: unknown[]) => requireUserId(...a) }));
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: (...a: unknown[]) => findRepository(...a) },
    releaseFixSeries: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
vi.mock("@/lib/github/issues-api", () => ({
  createIssue: (...a: unknown[]) => createIssue(...a),
  createComment: vi.fn(async () => ({})),
  fetchIssueStateOrThrow: vi.fn(async () => "open"),
}));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
vi.mock("@/lib/release-review-decision-store", () => ({
  resolveReleaseDecisionChain: vi.fn(async () => [11]),
  releaseDecisionScopeKey: () => "o/r#11",
  saveReleaseReviewDecision: (...a: unknown[]) => saveDecision(...a),
}));
vi.mock("@/lib/release-review-recommendation-store", () => ({
  findUsableRecommendation: (...a: unknown[]) => findRecommendation(...a),
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/review-decisions/bulk/route";
import { RELEASE_REVIEW_BULK_FALLBACK_REASON } from "@/lib/release-review-bulk";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const f1 = { id: "R-0000aa", severity: "high", title: "承認が残る", detail: "d", file: null, line: null, pullRequests: [] };
const f2 = { id: "R-0000bb", severity: "medium", title: "待ち時間が固定", detail: "d", file: null, line: null, pullRequests: [] };
const draft = (reason: string) => ({ reason, impact: null, scope: null, timing: null, followUpTitle: null });
const rec = {
  id: "rec2",
  recommended: "post_release",
  drafts: {
    fix_now: draft("直す"),
    post_release: { ...draft("後で"), timing: "次のリリースまで", followUpTitle: "待ち時間を設定できるようにする" },
    defer: draft("見送る"),
    reject: draft("対象外"),
  },
};

function request(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    json: async () => ({ owner: "o", repo: "r", pullRequestNumber: 11, baseSha: BASE, headSha: HEAD, items, ...extra }),
  } as unknown as NextRequest;
}

const fallbackItem = { findingId: f1.id, expectedDecisionId: null, recommendationId: null, decision: "fix_now", reason: "", fallback: true };
const postReleaseItem = {
  findingId: f2.id,
  expectedDecisionId: null,
  recommendationId: "rec2",
  decision: "post_release",
  reason: "後で",
  timing: "次のリリースまで",
  followUp: { kind: "create", title: "待ち時間を設定できるようにする" },
  fallback: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  findRepository.mockResolvedValue({ installation: { installationId: 1 } });
  fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: HEAD } });
  loadSummary.mockResolvedValue({ aiReview: { state: "needs_check", findings: [f1, f2], suggestions: [], decisions: null } });
  createIssue.mockResolvedValue({ number: 5201 });
  findRecommendation.mockImplementation(async (id: string) => (id === "rec2" ? rec : null));
  saveDecision.mockImplementation(async (input: Record<string, unknown>) => ({ ok: true, record: { id: `d-${String(input.findingId)}`, ...input } }));
});

describe("POST /api/repositories/release/review-decisions/bulk", () => {
  it("推奨どおりの判断と、推奨の無い止める指摘の安全側をまとめて保存する", async () => {
    const res = await POST(request([fallbackItem, postReleaseItem]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, failed: 0 });
    expect(saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: f1.id, decision: "fix_now", reason: RELEASE_REVIEW_BULK_FALLBACK_REASON, reasonSource: "fallback", recommendation: null }),
    );
    expect(createIssue).toHaveBeenCalledWith("o", "r", "token", expect.objectContaining({ title: "待ち時間を設定できるようにする" }));
    expect(saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: f2.id, decision: "post_release", followUp: { repo: "o/r", number: 5201 }, reasonSource: "ai" }),
    );
  });

  it("安全側は「今回直す」だけ。推奨の無い通常の項目・撤回・既存Issueへの関連付けは受け付けない", async () => {
    expect((await POST(request([{ ...fallbackItem, decision: "defer" }]))).status).toBe(400);
    expect((await POST(request([{ ...postReleaseItem, recommendationId: null }]))).status).toBe(400);
    expect((await POST(request([{ ...fallbackItem, fallback: false, decision: "withdrawn", reason: "x" }]))).status).toBe(400);
    expect((await POST(request([{ ...postReleaseItem, followUp: { kind: "existing", number: 1 } }]))).status).toBe(400);
    expect((await POST(request([fallbackItem, fallbackItem]))).status).toBe(400);
    expect((await POST(request([]))).status).toBe(400);
    expect(saveDecision).not.toHaveBeenCalled();
  });

  it("候補が更新されていたら何も保存しない", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: "c".repeat(40) } });
    const res = await POST(request([fallbackItem, postReleaseItem]));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("release_pr_changed");
    expect(saveDecision).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("1件が失敗しても確定済みの分は残し、項目ごとの結果を返す", async () => {
    createIssue.mockRejectedValue(new Error("boom"));
    const res = await POST(request([fallbackItem, postReleaseItem]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.results).toEqual([
      { findingId: f1.id, ok: true },
      expect.objectContaining({ findingId: f2.id, ok: false, error: "github_api_error" }),
    ]);
    expect(saveDecision).toHaveBeenCalledTimes(1);
  });

  it("古い推奨・競合した判断は項目ごとに失敗として返す", async () => {
    findRecommendation.mockResolvedValue(null);
    const res = await POST(request([{ ...fallbackItem, expectedDecisionId: "old" }, postReleaseItem]));
    const body = await res.json();
    expect(body.results.map((r: { error?: string }) => r.error)).toEqual(["decision_conflict", "recommendation_stale"]);
    expect(saveDecision).not.toHaveBeenCalled();
  });
});
