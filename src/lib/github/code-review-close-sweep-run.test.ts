import { beforeEach, describe, expect, it, vi } from "vitest";

const issueFindMany = vi.fn();
const fetchCommentsForIssue = vi.fn();
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
  get fetchCommentsForIssue() {
    return fetchCommentsForIssue;
  },
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

import { CODE_REVIEW_REPORT_MARKER, CODE_REVIEW_REQUEST_MARKER } from "./code-review";
import { clearCodeReviewSummaryCache } from "./code-review-report-cache";
import {
  resetCodeReviewCloseSweepMemoForTest,
  sweepCompletedCodeReviews,
} from "./code-review-close-sweep-run";

const REPOSITORY = {
  ownerLogin: "guchi-apps",
  name: "vps",
  fullName: "guchi-apps/vps",
  installation: { id: "inst-row", installationId: 111 },
};

function reviewRow(number: number, commentCount = 2) {
  return { number, commentCount, repositoryId: "repo-vps", repository: REPOSITORY };
}

function reportBody(...titles: string[]): string {
  return [CODE_REVIEW_REPORT_MARKER, "", ...titles.map((title) => `### [中] ${title}\n\n本文\n`)].join(
    "\n",
  );
}

/** 開いているレビューIssue（`title.startsWith`で絞る呼び出し）と、指摘のIssue（`title.in`）を振り分ける */
function mockDb(reviews: unknown[], findings: unknown[]) {
  issueFindMany.mockImplementation(async (args: { where?: { title?: { startsWith?: string } } }) =>
    args?.where?.title?.startsWith !== undefined ? reviews : findings,
  );
}

const tokenFor = vi.fn(async () => "token");

function run() {
  const countSkip = vi.fn();
  return { countSkip, result: sweepCompletedCodeReviews({ tokenFor, countSkip }) };
}

describe("sweepCompletedCodeReviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCodeReviewSummaryCache();
    resetCodeReviewCloseSweepMemoForTest();
    fetchCommentsForIssue.mockResolvedValue([
      { body: CODE_REVIEW_REQUEST_MARKER },
      { body: reportBody("指摘A", "指摘B") },
    ]);
    hasReopenedEvent.mockResolvedValue(false);
    updateIssue.mockResolvedValue({});
    createComment.mockResolvedValue({});
  });

  it("全指摘の起票済みIssueがcloseされていれば、レビューIssueをcompletedで閉じてコメントを残す", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );

    const { result, countSkip } = run();

    expect(await result).toEqual([{ repositoryFullName: "guchi-apps/vps", issueNumber: 241 }]);
    expect(updateIssue).toHaveBeenCalledWith("guchi-apps", "vps", 241, "token", {
      state: "closed",
      state_reason: "completed",
    });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][4].body).toContain("指摘2件");
    expect(countSkip).not.toHaveBeenCalled();
  });

  it("openな指摘のIssueが残っていれば閉じない（GitHubへの確認も出さない）", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "OPEN" },
      ],
    );

    const { result } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(hasReopenedEvent).not.toHaveBeenCalled();
    // コメント取得は要約を作るための1回だけ（closeの直前確認には進まない）
    expect(fetchCommentsForIssue).toHaveBeenCalledTimes(1);
  });

  it("起票されていない指摘があれば閉じない", async () => {
    mockDb([reviewRow(241)], [{ number: 10, title: "指摘A", state: "CLOSED" }]);

    const { result } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("指摘0件・結果待ちのレビューは指摘のIssueを引きにも行かない", async () => {
    mockDb([reviewRow(1), reviewRow(2)], []);
    fetchCommentsForIssue
      .mockResolvedValueOnce([{ body: reportBody() }])
      .mockResolvedValueOnce([{ body: CODE_REVIEW_REQUEST_MARKER }]);

    const { result } = run();

    expect(await result).toEqual([]);
    // 開いているレビューIssueを引く1回だけ
    expect(issueFindMany).toHaveBeenCalledTimes(1);
  });

  it("再レビューの依頼が結果より後ろに来ていたら閉じない", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    // 要約を作る1回目は結果だけ、closeの直前の取り直しでは再レビューの依頼が増えている
    fetchCommentsForIssue
      .mockResolvedValueOnce([{ body: reportBody("指摘A", "指摘B") }])
      .mockResolvedValueOnce([
        { body: reportBody("指摘A", "指摘B") },
        { body: CODE_REVIEW_REQUEST_MARKER },
      ]);

    const { result, countSkip } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(countSkip).toHaveBeenCalledWith("review_rerun_pending");
  });

  it("人が開け直したレビューIssueは閉じ直さず、次の巡回では確認も出さない", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    hasReopenedEvent.mockResolvedValue(true);

    const first = run();
    expect(await first.result).toEqual([]);
    expect(first.countSkip).toHaveBeenCalledWith("review_reopened");
    expect(updateIssue).not.toHaveBeenCalled();

    hasReopenedEvent.mockClear();
    fetchCommentsForIssue.mockClear();
    const second = run();
    expect(await second.result).toEqual([]);
    expect(hasReopenedEvent).not.toHaveBeenCalled();
    expect(fetchCommentsForIssue).not.toHaveBeenCalled();
  });

  it("開け直しの有無を確かめられなければ閉じない", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    hasReopenedEvent.mockResolvedValue(null);

    const { result, countSkip } = run();

    expect(await result).toEqual([]);
    expect(updateIssue).not.toHaveBeenCalled();
    expect(countSkip).toHaveBeenCalledWith("review_reopen_unknown");
  });

  it("closeに失敗したら成果に数えず、失敗として数える", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    updateIssue.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, countSkip } = run();

    expect(await result).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();
    expect(countSkip).toHaveBeenCalledWith("action_failed");
  });

  it("コメントの投稿に失敗しても、閉じた事実は成果として数える", async () => {
    mockDb(
      [reviewRow(241)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    createComment.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = run();

    expect(await result).toEqual([{ repositoryFullName: "guchi-apps/vps", issueNumber: 241 }]);
  });

  it("1件のコメント取得に失敗しても、残りのレビューIssueは処理する", async () => {
    mockDb(
      [reviewRow(1), reviewRow(2)],
      [
        { number: 10, title: "指摘A", state: "CLOSED" },
        { number: 11, title: "指摘B", state: "CLOSED" },
      ],
    );
    fetchCommentsForIssue.mockRejectedValueOnce(new Error("500"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, countSkip } = run();

    expect(await result).toEqual([{ repositoryFullName: "guchi-apps/vps", issueNumber: 2 }]);
    expect(countSkip).toHaveBeenCalledWith("fetch_failed");
  });

  it("開いているレビューIssueが無ければ何も引かない", async () => {
    mockDb([], []);

    const { result } = run();

    expect(await result).toEqual([]);
    expect(fetchCommentsForIssue).not.toHaveBeenCalled();
  });
});
