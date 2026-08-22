import { describe, expect, it } from "vitest";

import {
  canMergeIssuePullRequest,
  isIssuePullRequestSettling,
  issuePullRequestStateLabel,
  selectIssuePullRequests,
  summarizeIssuePullRequestStates,
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null },
    mergeable: true,
    repairRun: null,
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

  it("コンフリクトしているPRはマージできない（#2145）", () => {
    expect(canMergeIssuePullRequest(pullRequest({ mergeable: false }))).toBe(false);
  });

  it("コンフリクトの判定前（null）はマージボタンを出す（#2145）", () => {
    expect(canMergeIssuePullRequest(pullRequest({ mergeable: null }))).toBe(true);
  });
});

describe("isIssuePullRequestSettling", () => {
  it("CI実行中はまだ動いている", () => {
    expect(isIssuePullRequestSettling(pullRequest({ ciStatus: "in_progress" }))).toBe(true);
  });

  it("自動マージ可否の判定中はまだ動いている", () => {
    expect(
      isIssuePullRequestSettling(
        pullRequest({ mergeJudgement: { state: "pending", step: null, runUrl: null } }),
      ),
    ).toBe(true);
  });

  it("CIが通っていても自動修復が走っていればまだ動いている（#2145）", () => {
    expect(
      isIssuePullRequestSettling(
        pullRequest({
          ciStatus: "success",
          repairRun: { kind: "conflict", startedAt: "2026-08-22T00:00:00.000Z", runUrl: null },
        }),
      ),
    ).toBe(true);
  });

  it("CIが確定して判定も修復も無ければ動いていない", () => {
    expect(isIssuePullRequestSettling(pullRequest({ ciStatus: "failure" }))).toBe(false);
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

describe("summarizeIssuePullRequestStates", () => {
  it("状態ごとに数え、進んだ状態から順に並べる", () => {
    const summary = summarizeIssuePullRequestStates(
      [
        pullRequest({ number: 1, draft: true }),
        pullRequest({ number: 2 }),
        pullRequest({ number: 3, state: "closed", merged: true }),
        pullRequest({ number: 4, state: "closed", merged: true }),
      ],
      4,
    );
    expect(summary.total).toBe(4);
    expect(summary.buckets).toEqual([
      { state: "merged", count: 2 },
      { state: "open", count: 1 },
      { state: "draft", count: 1 },
    ]);
  });

  it("詳細が1件も取れていなくても件数は出す（畳んだ行から対応PRの存在が消えないように）", () => {
    const summary = summarizeIssuePullRequestStates([], 6);
    expect(summary.total).toBe(6);
    expect(summary.buckets).toEqual([]);
  });

  it("総数は詳細の件数ではなくリンクの件数を正とする", () => {
    const summary = summarizeIssuePullRequestStates([pullRequest()], 3);
    expect(summary.total).toBe(3);
    expect(summary.buckets).toEqual([{ state: "open", count: 1 }]);
  });
});
