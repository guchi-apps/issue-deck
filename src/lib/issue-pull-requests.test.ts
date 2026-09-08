import { describe, expect, it } from "vitest";

import {
  areIssuePullRequestsAllMerged,
  canMergeIssuePullRequest,
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

/**
 * #2914。マージ待ちの操作一式（マージボタン・レビュー本文・修正依頼欄）を引っ込める判定で、
 * 画面上部の対応PRセクションとコメント欄の承認カードが同じ条件を使う。
 */
describe("areIssuePullRequestsAllMerged", () => {
  const links = [
    { number: 616, url: "https://github.com/m-guchi/issue-deck/pull/616" },
    { number: 620, url: "https://github.com/m-guchi/issue-deck/pull/620" },
  ];

  it("全部マージ済みならtrue", () => {
    expect(areIssuePullRequestsAllMerged(links, new Set([616, 620]))).toBe(true);
  });

  it("1件でも残っていればfalse", () => {
    expect(areIssuePullRequestsAllMerged(links, new Set([616]))).toBe(false);
  });

  /** 空のまま`every`を評価すると、対応PRが0件のIssueまで「全部マージ済み」になる */
  it("1件もマージしていなければfalse（対応PRが0件のIssueも含む）", () => {
    expect(areIssuePullRequestsAllMerged(links, new Set())).toBe(false);
    expect(areIssuePullRequestsAllMerged([], new Set())).toBe(false);
  });
});
