import { describe, expect, it } from "vitest";

import {
  tallyReleaseReviews,
  toReleaseChangeCi,
  toReleaseChanges,
  withFixedBy,
  withMergeChecks,
  withReleaseReviews,
  withoutReleasedByPick,
} from "@/lib/release-changes";

function merge(sha: string, n: number, branch: string, title: string) {
  return { sha, message: `Merge pull request #${n} from guchi-apps/${branch}\n\n${title}` };
}

describe("toReleaseChanges", () => {
  it("PR単位に畳み、IssueなしPR・同一Issueの複数PRも別々に出す", () => {
    const { pullRequests, unknownCommits } = toReleaseChanges([
      { sha: "c0", message: "作業コミット" },
      merge("c1", 10, "issue-5", "最初のPR"),
      merge("c2", 11, "issue-5", "同じIssueの2つ目のPR"),
      merge("c3", 12, "hotfix-x", "Issueなしのブランチ"),
    ]);
    expect(pullRequests.map((pr) => [pr.number, pr.issueNumber])).toEqual([
      [12, null],
      [11, 5],
      [10, 5],
    ]);
    expect(unknownCommits).toEqual([]);
  });

  it("同じPR番号は重複させない", () => {
    const { pullRequests } = toReleaseChanges([
      merge("c1", 10, "issue-5", "PR"),
      { sha: "c2", message: "PR (#10)" },
      merge("c3", 11, "issue-6", "別のPR"),
    ]);
    expect(pullRequests.map((pr) => pr.number).sort()).toEqual([10, 11]);
  });

  it("squash運用でPR番号を特定できないコミットは対応不明として分ける", () => {
    const { pullRequests, unknownCommits } = toReleaseChanges([
      { sha: "s1", message: "直接コミット" },
      { sha: "s2", message: "機能追加 (#20)" },
    ]);
    expect(pullRequests.map((pr) => pr.number)).toEqual([20]);
    expect(unknownCommits).toEqual([{ sha: "s1", title: "直接コミット" }]);
  });

  it("バージョンバンプPRは印を付ける", () => {
    const { pullRequests } = toReleaseChanges([merge("b1", 30, "release/v1.2.3", "v1.2.3へ")]);
    expect(pullRequests[0].isVersionBump).toBe(true);
  });
});

describe("withReleaseReviews / tallyReleaseReviews", () => {
  const body = (review: string) =>
    `本文\n\n<!-- issue-deck-verification:start review=${review} risk=none -->\n- 自動レビュー: 問題なし\n<!-- issue-deck-verification:end -->`;
  const base = toReleaseChanges([
    merge("c1", 10, "issue-5", "PR10"),
    merge("c2", 11, "issue-6", "PR11"),
    merge("c3", 12, "issue-7", "PR12"),
    merge("c4", 13, "release/v1.0.0", "v1.0.0をリリースする"),
  ]).pullRequests;

  it("本文の判定を付け、取得できなかったPRは記録なしと区別する", () => {
    const result = withReleaseReviews(
      base,
      new Map([
        [10, { body: body("lgtm"), headSha: "aaa" }],
        [11, { body: "節なし", headSha: "bbb" }],
      ]),
    );
    const by = new Map(result.map((pr) => [pr.number, pr]));
    expect(by.get(10)?.review?.reviewKind).toBe("ok");
    expect(by.get(11)).toMatchObject({ review: null, reviewUnavailable: false });
    expect(by.get(12)).toMatchObject({ review: null, reviewUnavailable: true });
    const tally = tallyReleaseReviews(result);
    expect(tally).toMatchObject({ total: 2, ok: 1, unknown: 1, unavailable: 1 });
  });
});

describe("withMergeChecks（#4305）", () => {
  const base = (number: number, issueNumber: number | null, isVersionBump = false) =>
    ({ number, title: "t", issueNumber, isVersionBump, review: null, prHeadSha: null, reviewUnavailable: false }) as never;

  it("取れなかったCIは取得不可にし、バンプは触らない（計画は持たない）", () => {
    const result = withMergeChecks(
      [base(1, 10), base(2, null), base(3, 11, true)],
      new Map([[1, { state: "success" as const }]]),
    );
    expect(result[0].mergeChecks).toEqual({ ci: { state: "success" } });
    expect(result[1].mergeChecks?.ci.state).toBe("unavailable");
    expect(result[2].mergeChecks).toBeUndefined();
  });

  it("チェック集約の状態をCIの記録へ写す", () => {
    expect(toReleaseChangeCi("success").state).toBe("success");
    expect(toReleaseChangeCi("expected").state).toBe("pending");
    expect(toReleaseChangeCi("error").state).toBe("failure");
    expect(toReleaseChangeCi(null).state).toBe("none");
  });
});

describe("withFixedBy（#5175）", () => {
  const pr = (number: number, isVersionBump = false) => ({
    number,
    title: `PR${number}`,
    issueNumber: null,
    isVersionBump,
    review: null,
    prHeadSha: null,
    reviewUnavailable: false,
  });
  const series = (over: Partial<Parameters<typeof withFixedBy>[1][number]> = {}) => ({
    status: "fix_merged",
    sourceKind: "review_finding",
    issueNumber: 354,
    fixPrNumber: 355,
    fixPrMergedAt: new Date("2026-01-01"),
    relatedPullRequests: [352],
    ...over,
  });
  const run = (rows: Parameters<typeof withFixedBy>[1], list = [pr(355), pr(352)]) =>
    withFixedBy(list, rows).find((p) => p.number === 352)?.fixedBy;

  it("条件を満たすと元PRに修正PRを付ける", () => {
    expect(run([series()])).toEqual({ fixPrNumber: 355, fixIssueNumber: 354 });
  });
  it.each([
    ["stopped", { status: "stopped" }],
    ["superseded", { status: "superseded" }],
    ["統合検証の系列", { sourceKind: "integration_failure" }],
    ["修正PRが未マージ", { fixPrMergedAt: null }],
    ["修正PR番号なし", { fixPrNumber: null }],
    ["関連PRが空", { relatedPullRequests: [] }],
  ])("%sは付けない", (_label, over) => {
    expect(run([series(over)])).toBeUndefined();
  });
  it("修正PRが一覧に無ければ付けない", () => {
    expect(run([series()], [pr(352)])).toBeUndefined();
  });
  it("修正PR自身とバンプPRには付けない", () => {
    const result = withFixedBy([pr(355), pr(352, true)], [series({ relatedPullRequests: [355, 352] })]);
    expect(result.every((p) => p.fixedBy === undefined)).toBe(true);
  });
});

describe("withoutReleasedByPick（#5469）", () => {
  // RC-48でcherry-pickされた#1012の、developの元のマージ（親2つ）とそのブランチ内コミットがRC-49の範囲に残る形
  const commits = [
    { sha: "s1", message: "AI生成の検索語から演算子を含む条件を除外する (#1011)", parents: 1 },
    { sha: "s2", message: "Merge pull request #1012 from o/issue-1011\n\n検索語の修正", parents: 2 },
    { sha: "s3", message: "Merge pull request #1013 from o/release-sync/main-abc\n\n同期", parents: 2 },
    { sha: "s4", message: "メール検索の不具合を直す。 #1014", parents: 1 },
    { sha: "s5", message: "Merge pull request #1016 from o/issue-1014\n\n検索の修正", parents: 2 },
  ];
  const folded = () => toReleaseChanges(commits.map((c) => ({ sha: c.sha, message: c.message })));
  const sources = (over: Partial<Record<string, number | null>> = {}) =>
    commits.map((c) => ({ message: c.message, parentCount: c.sha in over ? (over[c.sha] ?? null) : c.parents }));

  it("mainでpick済みのPRの元のマージを結果から外し、ブランチ内コミットを個別の行として復活させない", () => {
    const { pullRequests, unknownCommits } = folded();
    const result = withoutReleasedByPick(pullRequests, sources(), new Set([1012, 999]));
    expect(result.pullRequests.map((p) => p.number)).toEqual([1016, 1013]);
    expect(result.releasedByPick).toEqual([1012]);
    expect(unknownCommits).toEqual([]);
  });

  it("範囲内のマージが親1つ（候補自身のcherry-pick）なら外さない", () => {
    const result = withoutReleasedByPick(folded().pullRequests, sources({ s2: 1 }), new Set([1012]));
    expect(result.pullRequests.map((p) => p.number)).toContain(1012);
    expect(result.releasedByPick).toEqual([]);
  });

  it("親の数が分からなければ外さない", () => {
    const result = withoutReleasedByPick(folded().pullRequests, sources({ s2: null }), new Set([1012]));
    expect(result.releasedByPick).toEqual([]);
  });

  it("mainの取り込みが取れなければ（空集合）何も外さない", () => {
    expect(withoutReleasedByPick(folded().pullRequests, sources(), new Set()).releasedByPick).toEqual([]);
  });
});
