import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  findFirst: vi.fn(),
  getInstallationToken: vi.fn(),
  fetchPullRequest: vi.fn(),
  fetchWorkflowRunsForHead: vi.fn(),
  rerunWorkflowRun: vi.fn(),
  convertPullRequestToDraft: vi.fn(),
  markPullRequestReadyForReview: vi.fn(),
}));

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/auth-user", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: mocks.getInstallationToken }));
vi.mock("@/lib/github/actions-api", () => ({
  fetchWorkflowRunsForHead: mocks.fetchWorkflowRunsForHead,
  rerunWorkflowRun: mocks.rerunWorkflowRun,
  convertPullRequestToDraft: mocks.convertPullRequestToDraft,
  markPullRequestReadyForReview: mocks.markPullRequestReadyForReview,
}));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequest: mocks.fetchPullRequest }));

import { POST } from "./route";

const pr = {
  state: "open",
  merged: false,
  draft: false,
  node_id: "PR_1",
  base: { ref: "develop" },
  head: { sha: "aaa" },
};
const reviewRun = {
  id: 7,
  name: "Claude Code Review",
  path: ".github/workflows/claude-review-develop.yml",
  status: "completed",
  conclusion: "failure",
  head_sha: "aaa",
  event: "pull_request",
  html_url: null,
};
const refused = new GithubApiError(403, 'GitHub API request failed: 403 {"message":"This workflow run cannot be retried"}');

function post() {
  return POST({
    json: async () => ({ owner: "o", repo: "r", number: 5, headSha: "aaa" }),
  } as unknown as NextRequest);
}

describe("POST /api/pull-requests/review-rerun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserId.mockResolvedValue("user");
    mocks.findFirst.mockResolvedValue({ installation: { installationId: 1 } });
    mocks.getInstallationToken.mockResolvedValue("token");
    mocks.fetchPullRequest.mockResolvedValue(pr);
    mocks.fetchWorkflowRunsForHead.mockResolvedValue([reviewRun]);
    mocks.rerunWorkflowRun.mockResolvedValue(undefined);
    mocks.convertPullRequestToDraft.mockResolvedValue(undefined);
    mocks.markPullRequestReadyForReview.mockResolvedValue(undefined);
  });

  it("再実行できるrunはPRの状態を変えない", async () => {
    const response = await post();
    expect(await response.json()).toMatchObject({ ok: true, method: "rerun", runId: 7 });
    expect(mocks.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it("GitHubが再実行を拒んだら、下書き経由で起動する", async () => {
    mocks.rerunWorkflowRun.mockRejectedValue(refused);
    const response = await post();
    expect(await response.json()).toEqual({ ok: true, method: "restart" });
    expect(mocks.convertPullRequestToDraft).toHaveBeenCalledWith("PR_1", "token");
    expect(mocks.markPullRequestReadyForReview).toHaveBeenCalledWith("PR_1", "token");
  });

  it("権限不足の403は下書きへ戻さず、権限不足として返す", async () => {
    mocks.rerunWorkflowRun.mockRejectedValue(new GithubApiError(403, "Resource not accessible by integration"));
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "permission_denied" });
    expect(mocks.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it("拒否の後に取り直したPRのHEADが変わっていたら、下書きへ戻さない", async () => {
    mocks.rerunWorkflowRun.mockRejectedValue(refused);
    mocks.fetchPullRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, head: { sha: "bbb" } });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "head_changed" });
    expect(mocks.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it("下書きへ戻せなければ、PRは変わっていないと返す", async () => {
    mocks.rerunWorkflowRun.mockRejectedValue(refused);
    mocks.convertPullRequestToDraft.mockRejectedValue(new Error("boom"));
    const response = await post();
    expect(await response.json()).toEqual({ error: "restart_failed" });
    expect(mocks.markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  it("レビュー可能へ戻すのは一時的な失敗なら再試行し、戻せなければ下書きのままと返す", async () => {
    mocks.rerunWorkflowRun.mockRejectedValue(refused);
    mocks.markPullRequestReadyForReview.mockRejectedValueOnce(new Error("flaky"));
    expect(await (await post()).json()).toEqual({ ok: true, method: "restart" });
    expect(mocks.markPullRequestReadyForReview).toHaveBeenCalledTimes(2);

    mocks.markPullRequestReadyForReview.mockReset();
    mocks.markPullRequestReadyForReview.mockRejectedValue(new Error("down"));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "ready_failed" });
    expect(mocks.markPullRequestReadyForReview).toHaveBeenCalledTimes(3);
  });
});
