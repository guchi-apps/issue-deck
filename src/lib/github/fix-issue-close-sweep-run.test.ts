import { beforeEach, describe, expect, it, vi } from "vitest";

const issueFindMany = vi.fn();
const fetchPullRequest = vi.fn();
const fetchPullRequestsForHead = vi.fn();
const compareBranches = vi.fn();
const closePullRequest = vi.fn();
const createComment = vi.fn();
const hasReopenedEvent = vi.fn();
const updateIssue = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createComment() {
    return createComment;
  },
  get hasReopenedEvent() {
    return hasReopenedEvent;
  },
  get updateIssue() {
    return updateIssue;
  },
}));

vi.mock("@/lib/github/pull-requests-api", () => ({
  get fetchPullRequest() {
    return fetchPullRequest;
  },
  get fetchPullRequestsForHead() {
    return fetchPullRequestsForHead;
  },
}));

vi.mock("@/lib/github/branches-api", () => ({
  get compareBranches() {
    return compareBranches;
  },
}));

vi.mock("@/lib/github/actions-api", () => ({
  get closePullRequest() {
    return closePullRequest;
  },
}));

import {
  resetFixIssueCloseSweepMemoForTest,
  sweepClosableFixIssues,
} from "./fix-issue-close-sweep-run";

const REPOSITORY = {
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  fullName: "guchi-apps/issue-deck",
  installation: { id: "inst-row", installationId: 111 },
};

function fixIssueRow(number: number, targetPullRequestNumber: number) {
  return {
    number,
    body: `指摘です。\n\n- 対象PR: #${targetPullRequestNumber}`,
    repositoryId: "repo-issue-deck",
    repository: REPOSITORY,
  };
}

const tokenFor = vi.fn(async () => "token");

function run() {
  const countSkip = vi.fn();
  return { countSkip, result: sweepClosableFixIssues({ tokenFor, countSkip }) };
}

describe("sweepClosableFixIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixIssueCloseSweepMemoForTest();
    hasReopenedEvent.mockResolvedValue(false);
    updateIssue.mockResolvedValue({});
    createComment.mockResolvedValue({});
    fetchPullRequestsForHead.mockResolvedValue([]);
    closePullRequest.mockResolvedValue(undefined);
  });

  it("対象PRがマージされていれば、修正Issueをcompletedで閉じてコメントを残す", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });

    const { result, countSkip } = run();

    expect(await result).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3001, kind: "fix_issue_closed" },
    ]);
    expect(updateIssue).toHaveBeenCalledWith("guchi-apps", "issue-deck", 3001, "token", {
      state: "closed",
      state_reason: "completed",
    });
    expect(createComment.mock.calls[0][4].body).toContain("対象PR #2957");
    expect(countSkip).not.toHaveBeenCalled();
  });

  it("対象PRがまだopenなら閉じない（開け直しの確認も出さない）", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: false, state: "open" });

    const { result } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(hasReopenedEvent).not.toHaveBeenCalled();
  });

  it("対象PRがマージされずクローズされていれば閉じない", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: false, state: "closed" });

    const { result } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("開け直しの有無を確かめられなければ閉じない", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });
    hasReopenedEvent.mockResolvedValue(null);

    const { result, countSkip } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(countSkip).toHaveBeenCalledWith("fix_issue_reopen_unknown");
  });

  it("人が開け直した修正Issueは閉じ直さず、次の巡回では確認も出さない", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });
    hasReopenedEvent.mockResolvedValue(true);

    const first = run();
    expect(await first.result).toEqual([]);
    expect(first.countSkip).toHaveBeenCalledWith("fix_issue_reopened");
    expect(updateIssue).not.toHaveBeenCalled();

    hasReopenedEvent.mockClear();
    fetchPullRequest.mockClear();
    const second = run();
    expect(await second.result).toEqual([]);
    expect(hasReopenedEvent).not.toHaveBeenCalled();
    expect(fetchPullRequest).not.toHaveBeenCalled();
  });

  it("closeに失敗したら成果に数えず、失敗として数える", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });
    updateIssue.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, countSkip } = run();

    expect(await result).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
    expect(countSkip).toHaveBeenCalledWith("action_failed");
  });

  it("コメントの投稿に失敗しても、閉じた事実は成果として数える", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });
    createComment.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = run();

    expect(await result).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3001, kind: "fix_issue_closed" },
    ]);
  });

  it("1件の対象PR取得に失敗しても、残りの修正Issueは処理する", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957), fixIssueRow(3002, 2958)]);
    fetchPullRequest
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce({ merged: true, state: "closed" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, countSkip } = run();

    expect(await result).toEqual([
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3002, kind: "fix_issue_closed" },
    ]);
    expect(countSkip).toHaveBeenCalledWith("fetch_failed");
  });

  it("対象の修正Issueが無ければ何も引かない", async () => {
    issueFindMany.mockResolvedValue([]);

    const { result } = run();

    expect(await result).toEqual([]);
    expect(fetchPullRequest).not.toHaveBeenCalled();
  });

  it("修正PRが元PRのheadを取り込んでいれば、元PRをcloseして置き換え先をコメントする", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({
      number: 2957,
      merged: false,
      state: "open",
      head: { sha: "original-sha" },
    });
    fetchPullRequestsForHead.mockResolvedValue([{ number: 3002, head: { sha: "replacement-sha" } }]);
    compareBranches.mockResolvedValue({ aheadBy: 1, behindBy: 0, changedFiles: 1, lastCommitAt: null });

    const { result } = run();

    expect(await result).toEqual([
      {
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 3001,
        kind: "original_pr_closed",
        originalPullRequestNumber: 2957,
        replacementPullRequestNumber: 3002,
      },
    ]);
    expect(fetchPullRequestsForHead).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      null,
      "issue-3001",
      "open",
      "token",
    );
    expect(compareBranches).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "original-sha",
      "replacement-sha",
      "token",
    );
    expect(closePullRequest).toHaveBeenCalledWith("guchi-apps", "issue-deck", 2957, "token");
    expect(createComment).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      2957,
      "token",
      expect.objectContaining({ body: expect.stringContaining("修正PR #3002") }),
    );
  });

  it("修正PRが元PRを取り込んでいない、または比較できない場合は元PRをcloseしない", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({
      number: 2957,
      merged: false,
      state: "open",
      head: { sha: "original-sha" },
    });
    fetchPullRequestsForHead.mockResolvedValue([{ number: 3002, head: { sha: "replacement-sha" } }]);
    compareBranches.mockResolvedValue({ aheadBy: 1, behindBy: 1, changedFiles: 1, lastCommitAt: null });

    const { result } = run();

    expect(await result).toEqual([]);
    expect(closePullRequest).not.toHaveBeenCalled();

    compareBranches.mockResolvedValue(null);
    const retry = run();
    expect(await retry.result).toEqual([]);
    expect(closePullRequest).not.toHaveBeenCalled();
  });
});
