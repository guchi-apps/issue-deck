import { describe, expect, it } from "vitest";

import {
  ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS,
  ISSUE_PULL_REQUEST_POLL_INTERVAL_MS,
  issuePullRequestPollIntervalMs,
  issuePullRequestStateLabel,
  selectIssuePullRequests,
  summarizeIssuePullRequestStates,
} from "@/lib/issue-pull-requests";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairRun: null,
    linkedIssueNumber: 600,
    reviewVerdict: null,
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
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

describe("issuePullRequestPollIntervalMs", () => {
  it("CI実行中は20秒で追う", () => {
    expect(issuePullRequestPollIntervalMs([pullRequest({ ciStatus: "in_progress" })])).toBe(
      ISSUE_PULL_REQUEST_POLL_INTERVAL_MS,
    );
  });

  it("自動マージ可否の判定中は20秒で追う", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({
          mergeJudgement: { state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        }),
      ]),
    ).toBe(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
  });

  it("CIが通っていても自動修復が走っていれば20秒で追う（#2145）", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({
          ciStatus: "success",
          repairRun: { kind: "conflict", startedAt: "2026-08-22T00:00:00.000Z", runUrl: null },
        }),
      ]),
    ).toBe(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
  });

  it("コンフリクトだけが理由なら1分へ落とす（誰かが直すまで残るため。#2915）", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({ ciStatus: "success", repairRun: null, mergeable: false }),
      ]),
    ).toBe(ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS);
  });

  it("コンフリクトと数分で確定するものが混ざれば短い方を採る（#2915）", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({ number: 1, ciStatus: "success", mergeable: false }),
        pullRequest({ number: 2, ciStatus: "in_progress" }),
      ]),
    ).toBe(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
  });

  it("コンフリクトが解消されれば取り直さない（#2915）", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({ ciStatus: "success", repairRun: null, mergeable: true }),
      ]),
    ).toBeNull();
  });

  it("コンフリクト有無が未判定（null）なら取り直さない（判定前をコンフリクトとして扱わない）", () => {
    expect(
      issuePullRequestPollIntervalMs([
        pullRequest({ ciStatus: "success", repairRun: null, mergeable: null }),
      ]),
    ).toBeNull();
  });

  it("CIが確定して判定も修復もコンフリクトも無ければ取り直さない", () => {
    expect(issuePullRequestPollIntervalMs([pullRequest({ ciStatus: "failure" })])).toBeNull();
  });

  it("対応PRが1件も無ければ取り直さない", () => {
    expect(issuePullRequestPollIntervalMs([])).toBeNull();
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
