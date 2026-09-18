import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const releaseWorkflowExists = vi.fn();
const fetchOpenPullRequestsForBase = vi.fn();
const fetchReleaseRebuildCandidate = vi.fn();
const deleteBranch = vi.fn();
const dispatchReleaseWorkflow = vi.fn();
const closePullRequest = vi.fn();
const createComment = vi.fn();
const calls: string[] = [];

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/release-workflow-cache", () => ({
  get releaseWorkflowExists() {
    return releaseWorkflowExists;
  },
}));

vi.mock("@/lib/github/release-api", () => ({
  get fetchOpenPullRequestsForBase() {
    return fetchOpenPullRequestsForBase;
  },
  get fetchReleaseRebuildCandidate() {
    return fetchReleaseRebuildCandidate;
  },
  get deleteBranch() {
    return deleteBranch;
  },
  get dispatchReleaseWorkflow() {
    return dispatchReleaseWorkflow;
  },
}));

vi.mock("@/lib/github/actions-api", () => ({
  get closePullRequest() {
    return closePullRequest;
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createComment() {
    return createComment;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/rebuild/route";
import { GithubApiError } from "@/lib/github/github-api-error";

function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const releasePr = {
  number: 3021,
  html_url: "https://github.com/guchi-apps/issue-deck/pull/3021",
  title: "v6.4.0をmainへリリースする",
  body: null,
  head: { ref: "release-main/v6.4.0", sha: "abc" },
};

describe("POST /api/repositories/release/rebuild", () => {
  beforeEach(() => {
    calls.length = 0;
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    releaseWorkflowExists.mockReset().mockResolvedValue(true);
    fetchOpenPullRequestsForBase.mockReset().mockResolvedValue([releasePr]);
    fetchReleaseRebuildCandidate
      .mockReset()
      .mockResolvedValue({ aheadBy: 2, pullRequests: [{ number: 3022, title: "直す", issueNumber: 3020 }] });
    createComment.mockReset().mockImplementation(async () => calls.push("comment"));
    closePullRequest.mockReset().mockImplementation(async () => calls.push("close"));
    deleteBranch.mockReset().mockImplementation(async () => calls.push("delete"));
    dispatchReleaseWorkflow.mockReset().mockImplementation(async () => calls.push("dispatch"));
  });

  it("リリースPRを閉じて凍結ブランチを消してから、workflowを起動する", async () => {
    const res = await POST(
      request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumber: 3021, bumpKind: "patch" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["comment", "close", "delete", "dispatch"]);
    expect(deleteBranch).toHaveBeenCalledWith("guchi-apps", "issue-deck", "release-main/v6.4.0", "token");
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith("guchi-apps", "issue-deck", "token", "patch");
  });

  it("見ていたリリースPRと違えば何もせず409を返す", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumber: 3000 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("release_pr_changed");
    expect(calls).toEqual([]);
  });

  it("headがdevelopの旧世代のリリースPRは作り直さない（developを消さない）", async () => {
    fetchOpenPullRequestsForBase.mockResolvedValue([{ ...releasePr, head: { ref: "develop", sha: "abc" } }]);
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumber: 3021 }));
    expect(res.status).toBe(409);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("developに新しい変更が無ければ閉じない", async () => {
    fetchReleaseRebuildCandidate.mockResolvedValue({ aheadBy: 0, pullRequests: [] });
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumber: 3021 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_rebuild");
    expect(calls).toEqual([]);
  });

  it("閉じた後に上げ幅の指定で起動が落ちたら、閉じたことが分かるエラーを返す", async () => {
    dispatchReleaseWorkflow.mockRejectedValue(new GithubApiError(422, "Unexpected inputs provided"));
    const res = await POST(
      request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumber: 3021, bumpKind: "minor" }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("rebuild_dispatch_bump_kind_unsupported");
  });
});
