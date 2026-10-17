import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findRepository = vi.fn();
const fetchPullRequest = vi.fn();
const loadSummary = vi.fn();
const loadOrGenerate = vi.fn();
const getAppAiToken = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: (...a: unknown[]) => requireUserId(...a) }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: (...a: unknown[]) => findRepository(...a) } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken: (...a: unknown[]) => getAppAiToken(...a) }));
vi.mock("@/lib/claude/release-review-recommend", () => ({ generateReleaseReviewRecommendations: vi.fn() }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
vi.mock("@/lib/release-review-decision-store", () => ({
  resolveReleaseDecisionChain: vi.fn(async () => [11, 10]),
  releaseDecisionScopeKey: () => "o/r#10",
}));
vi.mock("@/lib/release-review-recommendation-store", () => ({
  loadOrGenerateRecommendations: (...a: unknown[]) => loadOrGenerate(...a),
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/review-recommendations/route";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const f = (id: string) => ({ id, severity: "high", title: id, detail: "", file: null, line: null, pullRequests: [] });
const decided = (decision: string, stale: string | null) => ({ current: { decision, reason: "前回の理由" }, stale, history: [] });

function request(body: Record<string, unknown> = {}) {
  return { json: async () => ({ owner: "o", repo: "r", pullRequestNumber: 11, baseSha: BASE, headSha: HEAD, ...body }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  findRepository.mockResolvedValue({ installation: { installationId: 1 } });
  fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: HEAD } });
  getAppAiToken.mockResolvedValue("ai-token");
  loadOrGenerate.mockResolvedValue({ status: "ready", byFinding: {}, failures: {} });
  loadSummary.mockResolvedValue({
    aiReview: {
      state: "needs_check",
      findings: [f("R-1"), f("R-2"), f("R-3")],
      suggestions: [f("R-4")],
      decisions: { byFinding: { "R-2": decided("defer", null), "R-3": decided("defer", "重大度が上がりました") } },
    },
  });
});

describe("POST /api/repositories/release/review-recommendations", () => {
  it("有効な判断がある指摘には推奨を作らず、前提が変わった判断は前回の判断を添えて対象にする", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    const input = loadOrGenerate.mock.calls[0][0];
    expect(input.key).toEqual({ scopeKey: "o/r#10", baseSha: BASE, headSha: HEAD });
    expect(input.targets.map((t: { id: string }) => t.id)).toEqual(["R-1", "R-3", "R-4"]);
    expect(input.targets[1].previousDecision).toEqual({ decision: "defer", reason: "前回の理由", stale: "重大度が上がりました" });
    expect(input.targets[2].blocking).toBe(false);
    expect(input.retry).toBe(false);
    expect(typeof input.generate).toBe("function");
  });

  it("再取得の指定を渡し、AIの認証情報が無ければ生成しない", async () => {
    getAppAiToken.mockResolvedValue(null);
    await POST(request({ retry: true }));
    expect(loadOrGenerate.mock.calls[0][0]).toMatchObject({ retry: true, generate: null });
  });

  it("候補が更新されていれば409で、推奨を作らない", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: "c".repeat(40) } });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(loadOrGenerate).not.toHaveBeenCalled();
  });

  it("ログインしていなければ401、所有していないリポジトリは404", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    requireUserId.mockResolvedValue("user-1");
    findRepository.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
  });
});
