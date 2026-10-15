import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findRepository = vi.fn();
const countSeries = vi.fn();
const fetchPullRequest = vi.fn();
const createIssue = vi.fn();
const createComment = vi.fn();
const fetchIssueStateOrThrow = vi.fn();
const loadSummary = vi.fn();
const saveDecision = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: (...a: unknown[]) => requireUserId(...a) }));
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: (...a: unknown[]) => findRepository(...a) },
    releaseFixSeries: { count: (...a: unknown[]) => countSeries(...a) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
vi.mock("@/lib/github/issues-api", () => ({
  createIssue: (...a: unknown[]) => createIssue(...a),
  createComment: (...a: unknown[]) => createComment(...a),
  fetchIssueStateOrThrow: (...a: unknown[]) => fetchIssueStateOrThrow(...a),
}));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
vi.mock("@/lib/release-review-decision-store", () => ({
  resolveReleaseDecisionChain: vi.fn(async () => [11, 10]),
  releaseDecisionScopeKey: () => "o/r#10",
  saveReleaseReviewDecision: (...a: unknown[]) => saveDecision(...a),
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/review-decisions/route";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const finding = { id: "R-0000aa", severity: "high", title: "フリート未配布", detail: "d", file: null, line: null, pullRequests: [] };

function request(body: Record<string, unknown>) {
  return {
    json: async () => ({
      owner: "o",
      repo: "r",
      pullRequestNumber: 11,
      baseSha: BASE,
      headSha: HEAD,
      findingId: finding.id,
      expectedDecisionId: null,
      decision: "post_release",
      reason: "公開後にしか配布できない",
      timing: "本番公開の直後",
      followUp: { kind: "existing", number: 4651 },
      ...body,
    }),
  } as unknown as NextRequest;
}

const summary = (decisions: unknown = null, findings = [finding]) => ({
  aiReview: { state: "needs_check", findings, suggestions: [], decisions },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  findRepository.mockResolvedValue({ installation: { installationId: 1 } });
  countSeries.mockResolvedValue(0);
  fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: HEAD } });
  loadSummary.mockResolvedValue(summary());
  fetchIssueStateOrThrow.mockResolvedValue("open");
  createIssue.mockResolvedValue({ number: 5000 });
  createComment.mockResolvedValue({});
  saveDecision.mockImplementation(async (input: Record<string, unknown>) => ({ ok: true, record: { id: "d1", ...input } }));
});

describe("POST /api/repositories/release/review-decisions", () => {
  it("公開後対応を既存Issueへ関連付けて保存し、対象と原判定を判断と別に記録する", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(200);
    expect(saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "o/r#10",
        findingId: finding.id,
        decision: "post_release",
        followUp: { repo: "o/r", number: 4651 },
        timing: "本番公開の直後",
        prNumber: 11,
        headRef: "release-rc/3",
        baseSha: BASE,
        headSha: HEAD,
        severity: "high",
        blocking: true,
        userId: "user-1",
      }),
    );
    expect(createIssue).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith("o", "r", 4651, "token", expect.anything());
  });

  it("ログインしていなければ401、所有していないリポジトリは404", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(request({}))).status).toBe(401);
    requireUserId.mockResolvedValue("user-1");
    findRepository.mockResolvedValue(null);
    expect((await POST(request({}))).status).toBe(404);
    expect(saveDecision).not.toHaveBeenCalled();
  });

  it("候補が更新されていれば保存しない（古い画面からの判断）", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: "c".repeat(40) } });
    const res = await POST(request({}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("release_pr_changed");
    expect(saveDecision).not.toHaveBeenCalled();
  });

  it("今の結果に無い指摘には判断を付けない", async () => {
    loadSummary.mockResolvedValue(summary(null, []));
    const res = await POST(request({}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("finding_not_current");
  });

  it("見ていた判断より新しい判断があれば、Issueを作らず409で止める（黙って上書きしない）", async () => {
    loadSummary.mockResolvedValue(
      summary({ byFinding: { [finding.id]: { history: [{ id: "other" }] } }, detached: [], counts: {}, cleared: false, postReleaseWork: [], next: "" }),
    );
    const res = await POST(request({ followUp: { kind: "create", title: "配布する" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("decision_conflict");
    expect(createIssue).not.toHaveBeenCalled();
    expect(saveDecision).not.toHaveBeenCalled();
  });

  it("見送りは影響・範囲が必須で、修正Issueや期限を作らない", async () => {
    expect((await POST(request({ decision: "defer", followUp: null }))).status).toBe(400);
    const res = await POST(request({ decision: "defer", followUp: null, timing: null, impact: "配布が遅れる", scope: "利用repo" }));
    expect(res.status).toBe(200);
    expect(createIssue).not.toHaveBeenCalled();
    expect(saveDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "defer", followUp: null, timing: null }));
  });

  it("新しいIssueはユーザーが明示したときだけ作る", async () => {
    const res = await POST(request({ followUp: { kind: "create", title: "フリートへ配布する" } }));
    expect(res.status).toBe(200);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(saveDecision).toHaveBeenCalledWith(expect.objectContaining({ followUp: { repo: "o/r", number: 5000 } }));
  });

  it("稼働中の修正系列があれば件数を返す（実行中の処理は止めない）", async () => {
    countSeries.mockResolvedValue(1);
    const res = await POST(request({ decision: "reject", followUp: null, timing: null, reason: "過剰な要求" }));
    expect((await res.json()).activeFixSeries).toBe(1);
  });
});
