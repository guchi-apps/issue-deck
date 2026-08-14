import { describe, expect, it } from "vitest";

import {
  canMergeIssuePullRequest,
  issuePullRequestStateLabel,
  selectIssuePullRequests,
} from "@/lib/issue-pull-requests";
import type { IssuePullRequest } from "@/types/pull-request";

function pullRequest(overrides: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return {
    number: 616,
    htmlUrl: "https://github.com/m-guchi/issue-deck/pull/616",
    title: "対応PRのタイトル",
    state: "open",
    draft: false,
    merged: false,
    ciStatus: "success",
    linkedIssueNumber: 600,
    ...overrides,
  };
}

describe("selectIssuePullRequests", () => {
  it("このIssueに紐づくPRを残す", () => {
    const result = selectIssuePullRequests([pullRequest({ linkedIssueNumber: 600 })], 600);
    expect(result).toHaveLength(1);
  });

  it("別のIssueに紐づくPRは落とす（コメント中の単なる言及を対応PRとして並べない）", () => {
    const result = selectIssuePullRequests([pullRequest({ linkedIssueNumber: 1327 })], 600);
    expect(result).toEqual([]);
  });

  it("対応Issueを推定できなかったPRは残す（ブランチ名が規約外なだけの対応PRを消さない）", () => {
    const result = selectIssuePullRequests([pullRequest({ linkedIssueNumber: null })], 600);
    expect(result).toHaveLength(1);
  });

  it("番号の昇順に並べる", () => {
    const result = selectIssuePullRequests(
      [pullRequest({ number: 620 }), pullRequest({ number: 616 })],
      600,
    );
    expect(result.map((pr) => pr.number)).toEqual([616, 620]);
  });
});

describe("canMergeIssuePullRequest", () => {
  it("openで下書きでもマージ済みでもなければマージできる", () => {
    expect(canMergeIssuePullRequest(pullRequest())).toBe(true);
  });

  it("下書きはマージできない", () => {
    expect(canMergeIssuePullRequest(pullRequest({ draft: true }))).toBe(false);
  });

  it("マージ済みはマージできない", () => {
    expect(canMergeIssuePullRequest(pullRequest({ state: "closed", merged: true }))).toBe(false);
  });

  it("クローズ済み（却下）はマージできない", () => {
    expect(canMergeIssuePullRequest(pullRequest({ state: "closed", merged: false }))).toBe(false);
  });
});

describe("issuePullRequestStateLabel", () => {
  it.each([
    [pullRequest(), "open"],
    [pullRequest({ draft: true }), "draft"],
    [pullRequest({ state: "closed", merged: true }), "merged"],
    [pullRequest({ state: "closed", merged: false }), "closed"],
    // マージ済みならdraftの値によらずマージ済みを優先する
    [pullRequest({ state: "closed", merged: true, draft: true }), "merged"],
  ])("状態を1つのラベルに畳む", (pr, expected) => {
    expect(issuePullRequestStateLabel(pr)).toBe(expected);
  });
});
