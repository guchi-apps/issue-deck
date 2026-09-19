import { describe, expect, it } from "vitest";

import {
  buildCodeReviewRepoRows,
  reviewIntervalRanges,
  sinceLastReviewRange,
} from "@/lib/code-review-repo-overview";
import type { Issue } from "@/types/issue";

const NOW = Date.parse("2026-09-19T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function review(repositoryFullName: string, daysAgo: number, id: string): Issue {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    title: `[レビュー] ${repositoryFullName.split("/")[1]}（2026-09-01）`,
    body: "",
    state: "closed",
    stateReason: null,
    repositoryFullName,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: new Date(NOW - daysAgo * DAY).toISOString(),
    updatedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${repositoryFullName}/issues/1`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
  };
}

function build(
  reviewIssues: Issue[],
  repositoryFullNames: string[],
  runnable: string[] = repositoryFullNames,
  pendingIds: string[] = [],
) {
  return buildCodeReviewRepoRows({
    reviewIssues,
    repositoryFullNames,
    canRun: (name) => runnable.includes(name),
    isPending: (issue) => pendingIds.includes(issue.id),
    now: NOW,
  });
}

describe("buildCodeReviewRepoRows", () => {
  it("未実施を先頭に、前回からの経過が長い順に並べる", () => {
    const rows = build(
      [review("o/deck", 2, "a1"), review("o/deck", 40, "a2"), review("o/car", 45, "b1")],
      ["o/deck", "o/car", "o/new"],
    );
    expect(rows.map((row) => row.repositoryFullName)).toEqual(["o/new", "o/car", "o/deck"]);
    expect(rows[0]).toMatchObject({ lastReviewedAt: null, daysSinceLast: null, stale: true });
    expect(rows[1]).toMatchObject({ daysSinceLast: 45, stale: true });
    expect(rows[2]).toMatchObject({ daysSinceLast: 2, stale: false });
    expect(rows[2].reviews.map((entry) => entry.issueId)).toEqual(["a2", "a1"]);
  });

  it("実行できず、レビューしたことも無いリポジトリは載せない。非表示のリポジトリのレビューも載せない", () => {
    const rows = build(
      [review("o/hidden", 3, "h1"), review("o/old", 10, "c1")],
      ["o/old", "o/idle"],
      [],
    );
    expect(rows.map((row) => [row.repositoryFullName, row.canRun])).toEqual([["o/old", false]]);
  });

  it("レビューでないIssueは数えない", () => {
    const issue = { ...review("o/deck", 1, "x1"), title: "普通のIssue" };
    const rows = build([issue], ["o/deck"]);
    expect(rows[0].reviews).toEqual([]);
  });

  it("帯の点は12週以内だけで、結果待ちを見分ける", () => {
    const rows = build(
      [review("o/deck", 100, "d1"), review("o/deck", 42, "d2"), review("o/deck", 0, "d3")],
      ["o/deck"],
      ["o/deck"],
      ["d3"],
    );
    expect(rows[0].dots).toEqual([
      { issueId: "d2", position: 0.5, pending: false },
      { issueId: "d3", position: 1, pending: true },
    ]);
  });
});

describe("数える期間", () => {
  const [row] = build(
    [review("o/deck", 30, "e1"), review("o/deck", 10, "e2"), review("o/deck", 2, "e3")],
    ["o/deck"],
  );

  it("前回から今まで", () => {
    expect(sinceLastReviewRange(row)).toEqual({
      repositoryFullName: "o/deck",
      from: new Date(NOW - 2 * DAY).toISOString(),
      to: null,
    });
  });

  it("ひとつ前のレビューからそのレビューまで。最初のレビューには期間が無い", () => {
    const ranges = reviewIntervalRanges(row);
    expect([...ranges.keys()]).toEqual(["e2", "e3"]);
    expect(ranges.get("e3")).toEqual({
      repositoryFullName: "o/deck",
      from: new Date(NOW - 10 * DAY).toISOString(),
      to: new Date(NOW - 2 * DAY).toISOString(),
    });
  });

  it("未実施なら前回からの期間は無い", () => {
    const [empty] = build([], ["o/new"]);
    expect(sinceLastReviewRange(empty)).toBeNull();
  });
});
