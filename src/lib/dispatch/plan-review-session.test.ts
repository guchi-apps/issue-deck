import { describe, expect, it } from "vitest";

import { parseDispatchPlanReviewSessions } from "./plan-review-session";

describe("parseDispatchPlanReviewSessions", () => {
  it("有効な対象だけを重複なく受け取る", () => {
    expect(
      parseDispatchPlanReviewSessions([
        { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3924 },
        { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3924 },
        { repositoryFullName: "invalid repository", issueNumber: 2 },
        { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 0 },
      ]),
    ).toEqual([
      {
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 3924,
        issueTitle: null,
        issueId: null,
      },
    ]);
  });

  it("配列以外は未申告として扱う", () => {
    expect(parseDispatchPlanReviewSessions(null)).toBeNull();
  });
});
