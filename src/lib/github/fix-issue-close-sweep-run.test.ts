import { beforeEach, describe, expect, it, vi } from "vitest";

const issueFindMany = vi.fn();
const fetchPullRequest = vi.fn();
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
  });

  it("対象PRがマージされていれば、修正Issueをcompletedで閉じてコメントを残す", async () => {
    issueFindMany.mockResolvedValue([fixIssueRow(3001, 2957)]);
    fetchPullRequest.mockResolvedValue({ merged: true, state: "closed" });

    const { result, countSkip } = run();

    expect(await result).toEqual([{ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3001 }]);
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
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3001 },
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
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3002 },
    ]);
    expect(countSkip).toHaveBeenCalledWith("fetch_failed");
  });

  it("対象の修正Issueが無ければ何も引かない", async () => {
    issueFindMany.mockResolvedValue([]);

    const { result } = run();

    expect(await result).toEqual([]);
    expect(fetchPullRequest).not.toHaveBeenCalled();
  });
});
