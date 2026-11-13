import { beforeEach, describe, expect, it, vi } from "vitest";

const findRepository = vi.fn();
const fetchPullRequest = vi.fn();
const loadSummary = vi.fn();
const loadOrGenerate = vi.fn();
const getAppAiToken = vi.fn();

vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: (...a: unknown[]) => findRepository(...a) } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken: (...a: unknown[]) => getAppAiToken(...a) }));
vi.mock("@/lib/claude/release-review-recommend", () => ({ generateReleaseReviewRecommendations: vi.fn() }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
vi.mock("@/lib/release-review-decision-store", () => ({
  resolveReleaseDecisionChain: vi.fn(async () => [11]),
  releaseDecisionScopeKey: () => "o/r#11",
}));
vi.mock("@/lib/release-review-recommendation-store", () => ({
  loadOrGenerateRecommendations: (...a: unknown[]) => loadOrGenerate(...a),
}));

import { prefetchReleaseReviewRecommendations } from "@/lib/release-review-recommendation-prefetch";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const f = (id: string) => ({ id, severity: "high", title: id, detail: "", file: null, line: null, pullRequests: [] });
const decided = { current: { decision: "fix_now", reason: "r" }, stale: null, history: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  findRepository.mockResolvedValue({ installation: { installationId: 1 } });
  fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-main/v1.0.0", sha: HEAD } });
  getAppAiToken.mockResolvedValue("ai-token");
  loadOrGenerate.mockResolvedValue({ status: "ready", byFinding: {}, failures: {} });
});

describe("prefetchReleaseReviewRecommendations", () => {
  it("判断済みの指摘を除いた未判断の指摘だけを生成へ渡す", async () => {
    loadSummary.mockResolvedValue({
      aiReview: { state: "needs_check", findings: [f("A"), f("B")], suggestions: [], decisions: { byFinding: { A: decided } } },
    });
    await prefetchReleaseReviewRecommendations("o/r", 11, { baseSha: BASE, headSha: HEAD });
    expect(loadOrGenerate).toHaveBeenCalledTimes(1);
    expect(loadOrGenerate.mock.calls[0][0].targets.map((t: { id: string }) => t.id)).toEqual(["B"]);
  });

  it("リリース候補が更新されていれば生成しない", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-main/v1.0.0", sha: "c".repeat(40) } });
    await prefetchReleaseReviewRecommendations("o/r", 11, { baseSha: BASE, headSha: HEAD });
    expect(loadOrGenerate).not.toHaveBeenCalled();
  });

  it("途中で失敗しても例外を投げない", async () => {
    fetchPullRequest.mockRejectedValue(new Error("boom"));
    await expect(prefetchReleaseReviewRecommendations("o/r", 11, { baseSha: BASE, headSha: HEAD })).resolves.toBeUndefined();
  });
});
