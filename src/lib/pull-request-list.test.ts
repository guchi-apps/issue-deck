import { describe, expect, it } from "vitest";

import {
  applyOptimisticMerges,
  classifyPullRequest,
  computePullRequestNavCounts,
  extractLinkedIssueNumber,
  extractLinkedIssueNumbers,
  filterPullRequestsByView,
  groupPullRequestsByRepository,
  canMergeFromDeck,
  isMergeJudgementPending,
  mergeJudgementLabel,
  mergeJudgementReason,
  mergeWarnings,
  pullRequestsAwaitingUserMerge,
  requiresUserMerge,
  sortOpenPullRequests,
  sortPullRequestsByUpdated,
} from "@/lib/pull-request-list";
import type { PullRequestSummary } from "@/types/pull-request";

function pullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "タイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/1",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1",
    kind: "issue",
    linkedIssueNumber: 1,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null },
    mergeable: null,
    repairWorkflowAvailability: {},
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("classifyPullRequest", () => {
  it("develop→mainはリリースPRとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "main", headRef: "develop" })).toBe("release");
  });

  it("release/vX.Y.Zブランチはバージョンバンプとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "release/v2.19.0" })).toBe(
      "version-bump",
    );
  });

  it("issue-<番号>ブランチは実装PRとして扱う", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "issue-1058" })).toBe("issue");
  });

  it("規約から外れたブランチはotherになる", () => {
    expect(classifyPullRequest({ baseRef: "develop", headRef: "feature/foo" })).toBe("other");
    // issue-<番号>の前後に余計な文字が付くものは実装PRとみなさない
    expect(classifyPullRequest({ baseRef: "develop", headRef: "issue-1058-fix" })).toBe("other");
  });
});

describe("extractLinkedIssueNumber", () => {
  it("ブランチ名を最優先で使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "issue-1058", title: "#999 の対応", body: null }),
    ).toBe(1058);
  });

  it("ブランチ名から取れない場合はタイトルの#参照を使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "feature/foo", title: "#624 の対応", body: "#625" }),
    ).toBe(624);
  });

  it("タイトルに無ければ本文の#参照を使う", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "feature/foo", title: "PRのタイトル", body: "対応Issue: #625" }),
    ).toBe(625);
  });

  it("手掛かりが無ければnullを返す", () => {
    expect(
      extractLinkedIssueNumber({ headRef: "release/v2.19.0", title: "v2.19.0", body: null }),
    ).toBeNull();
  });
});

describe("extractLinkedIssueNumbers", () => {
  it("参照をすべて確度の高い順に返す（ブランチ名→タイトル→本文）", () => {
    expect(
      extractLinkedIssueNumbers({
        headRef: "issue-1058",
        title: "#624 と #625 をまとめて直す",
        body: "対応Issue: #625 #700",
      }),
    ).toEqual([1058, 624, 625, 700]);
  });

  it("同じ番号は1度だけ返す", () => {
    expect(
      extractLinkedIssueNumbers({ headRef: "issue-624", title: "#624 の対応", body: "#624" }),
    ).toEqual([624]);
  });

  it("手掛かりが無ければ空配列を返す", () => {
    expect(
      extractLinkedIssueNumbers({ headRef: "release/v2.19.0", title: "v2.19.0", body: null }),
    ).toEqual([]);
  });
});

describe("sortOpenPullRequests", () => {
  it("作成が古い順に並べる", () => {
    const sorted = sortOpenPullRequests([
      pullRequest({ number: 2, createdAt: "2026-08-03T00:00:00Z" }),
      pullRequest({ number: 1, createdAt: "2026-08-01T00:00:00Z" }),
      pullRequest({ number: 3, createdAt: "2026-08-02T00:00:00Z" }),
    ]);
    expect(sorted.map((pr) => pr.number)).toEqual([1, 3, 2]);
  });

  it("元の配列を破壊しない", () => {
    const input = [
      pullRequest({ number: 2, createdAt: "2026-08-03T00:00:00Z" }),
      pullRequest({ number: 1, createdAt: "2026-08-01T00:00:00Z" }),
    ];
    sortOpenPullRequests(input);
    expect(input.map((pr) => pr.number)).toEqual([2, 1]);
  });
});

describe("sortPullRequestsByUpdated", () => {
  it("更新が新しい順に並べる", () => {
    const sorted = sortPullRequestsByUpdated([
      pullRequest({ number: 2, updatedAt: "2026-08-03T00:00:00Z" }),
      pullRequest({ number: 1, updatedAt: "2026-08-01T00:00:00Z" }),
      pullRequest({ number: 3, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);
    expect(sorted.map((pr) => pr.number)).toEqual([2, 3, 1]);
  });

  it("元の配列を破壊しない", () => {
    const input = [
      pullRequest({ number: 1, updatedAt: "2026-08-01T00:00:00Z" }),
      pullRequest({ number: 2, updatedAt: "2026-08-03T00:00:00Z" }),
    ];
    sortPullRequestsByUpdated(input);
    expect(input.map((pr) => pr.number)).toEqual([1, 2]);
  });
});

describe("filterPullRequestsByView", () => {
  // 「すべてのPR」はマージ済み・クローズ済みを含めるのをやめた（#1613）
  it("allはopenなPRだけを返す", () => {
    const pullRequests = [
      pullRequest({ number: 1 }),
      pullRequest({ number: 2, state: "closed", merged: true, ciState: "unknown" }),
    ];
    expect(filterPullRequestsByView(pullRequests, "all").map((pr) => pr.number)).toEqual([1]);
  });

  it("完了はCIが確定したopenなPRだけを返す", () => {
    const pullRequests = [
      pullRequest({ number: 1, ciState: "success" }),
      pullRequest({ number: 2, ciState: "failure" }),
      pullRequest({ number: 3, ciState: "pending" }),
      pullRequest({ number: 4, ciState: "unknown" }),
      pullRequest({ number: 5, draft: true, ciState: "unknown" }),
    ];
    expect(filterPullRequestsByView(pullRequests, "completed").map((pr) => pr.number)).toEqual([
      1, 2,
    ]);
  });

  // ドラフトはCI状態を取得していないので常にunknown。CI状態を取得したが確定していないPRと
  // 同じく「まだ判断できない」ため処理中側へ入れる。
  it("処理中はCI待ち・CI状態不明・ドラフトを返す", () => {
    const pullRequests = [
      pullRequest({ number: 1, ciState: "success" }),
      pullRequest({ number: 2, ciState: "failure" }),
      pullRequest({ number: 3, ciState: "pending" }),
      pullRequest({ number: 4, ciState: "unknown" }),
      pullRequest({ number: 5, draft: true, ciState: "unknown" }),
      pullRequest({ number: 6, draft: true, ciState: "success" }),
    ];
    expect(filterPullRequestsByView(pullRequests, "in-progress").map((pr) => pr.number)).toEqual([
      3, 4, 5, 6,
    ]);
  });

  it("処理中と完了でopenなPRを過不足なく二分する", () => {
    const pullRequests = [
      pullRequest({ number: 1, ciState: "success" }),
      pullRequest({ number: 2, ciState: "pending" }),
      pullRequest({ number: 3, draft: true, ciState: "unknown" }),
      pullRequest({ number: 4, ciState: "failure" }),
      // closedはどちらにも入らない（母集団はopenのみ）
      pullRequest({ number: 5, state: "closed", merged: true, ciState: "unknown" }),
    ];
    const inProgress = filterPullRequestsByView(pullRequests, "in-progress");
    const completed = filterPullRequestsByView(pullRequests, "completed");

    expect([...inProgress, ...completed].map((pr) => pr.number).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("computePullRequestNavCounts", () => {
  it("実行中・完了の件数を数え、すべてのPRはopenな全件を数える（#1613）", () => {
    const counts = computePullRequestNavCounts(
      [
        pullRequest({ number: 1, ciState: "success" }),
        pullRequest({ number: 2, ciState: "failure" }),
        pullRequest({ number: 3, ciState: "pending" }),
        pullRequest({ number: 4, draft: true, ciState: "unknown" }),
        pullRequest({ number: 5, state: "closed", merged: true, ciState: "unknown" }),
      ],
      true,
    );

    expect(counts).toEqual({ all: 4, "in-progress": 2, completed: 2 });
  });

  it("未取得のときはどのビューも件数を出さない", () => {
    expect(computePullRequestNavCounts([], false)).toEqual({
      all: null,
      "in-progress": null,
      completed: null,
    });
  });

  it("取得済みでPRが1件も無ければ0を出す", () => {
    expect(computePullRequestNavCounts([], true)).toEqual({
      all: 0,
      "in-progress": 0,
      completed: 0,
    });
  });

  // クローズ済みまで取得した結果を渡しても、openなPRしか数えないので値は変わらない。
  it("母集団にクローズ済みが含まれていても件数は変わらない", () => {
    const openOnly = [pullRequest({ number: 1, ciState: "success" })];
    const withClosed = [
      ...openOnly,
      pullRequest({ number: 2, state: "closed", merged: true, ciState: "unknown" }),
      pullRequest({ number: 3, state: "closed", merged: false, ciState: "unknown" }),
    ];

    expect(computePullRequestNavCounts(withClosed, true)).toEqual(
      computePullRequestNavCounts(openOnly, true),
    );
  });
});

describe("groupPullRequestsByRepository", () => {
  it("最も古いPRを持つリポジトリを先頭に並べる", () => {
    const groups = groupPullRequestsByRepository(
      [
        pullRequest({
          repositoryFullName: "guchi-apps/dayspan",
          number: 10,
          createdAt: "2026-08-05T00:00:00Z",
        }),
        pullRequest({
          repositoryFullName: "guchi-apps/issue-deck",
          number: 20,
          createdAt: "2026-08-01T00:00:00Z",
        }),
        pullRequest({
          repositoryFullName: "guchi-apps/dayspan",
          number: 11,
          createdAt: "2026-08-02T00:00:00Z",
        }),
      ],
      "in-progress",
    );

    // dayspanの最古は08-02、issue-deckの最古は08-01なのでissue-deckが先
    expect(groups.map((group) => group.repositoryFullName)).toEqual([
      "guchi-apps/issue-deck",
      "guchi-apps/dayspan",
    ]);
    expect(groups[1].pullRequests.map((pr) => pr.number)).toEqual([11, 10]);
  });

  // 全てのPRビューはマージ済みを含むため、作成が古い順だと完了済みの古いPRが先頭を占める（#1312）
  it("全てのPRビューでは更新が新しい順に並べる", () => {
    const groups = groupPullRequestsByRepository(
      [
        pullRequest({
          repositoryFullName: "guchi-apps/dayspan",
          number: 10,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-08-05T00:00:00Z",
        }),
        pullRequest({
          repositoryFullName: "guchi-apps/issue-deck",
          number: 20,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        }),
        pullRequest({
          repositoryFullName: "guchi-apps/dayspan",
          number: 11,
          createdAt: "2026-02-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
        }),
      ],
      "all",
    );

    expect(groups.map((group) => group.repositoryFullName)).toEqual([
      "guchi-apps/dayspan",
      "guchi-apps/issue-deck",
    ]);
    expect(groups[0].pullRequests.map((pr) => pr.number)).toEqual([10, 11]);
  });
});

describe("pullRequestsAwaitingUserMerge", () => {
  // 対応Issueを持たないリリースPRは、これが無いとどの確認待ちにも現れない（#1613）
  it("対応Issueが確認待ちの一覧に居ないマージ待ちPRだけを返す", () => {
    const release = pullRequest({
      number: 100,
      kind: "release",
      baseRef: "main",
      headRef: "develop",
      linkedIssueNumber: null,
    });
    const listed = pullRequest({
      number: 101,
      linkedIssueNumber: 1590,
      linkedIssueCheckReason: "merge",
      linkedIssueCheckUser: true,
    });
    const notListed = pullRequest({
      number: 102,
      linkedIssueNumber: 1600,
      linkedIssueCheckReason: "merge",
      linkedIssueCheckUser: true,
    });

    const result = pullRequestsAwaitingUserMerge(
      [release, listed, notListed],
      [{ repositoryFullName: "guchi-apps/issue-deck", number: 1590 }],
    );

    expect(result.map((pr) => pr.number)).toEqual([100, 102]);
  });

  it("マージ待ちでないPRは返さない", () => {
    const result = pullRequestsAwaitingUserMerge(
      [
        pullRequest({ number: 1, linkedIssueCheckUser: false }),
        pullRequest({ number: 2, autoMergeEnabled: true, linkedIssueCheckUser: true }),
        pullRequest({ number: 3, state: "closed", merged: true, linkedIssueCheckUser: true }),
      ],
      [],
    );

    expect(result).toEqual([]);
  });

  // リポジトリが違えば同じ番号でも別のIssue
  it("重複の判定はリポジトリと番号の組で行う", () => {
    const result = pullRequestsAwaitingUserMerge(
      [
        pullRequest({
          number: 5,
          linkedIssueNumber: 12,
          linkedIssueCheckReason: "merge",
          linkedIssueCheckUser: true,
        }),
      ],
      [{ repositoryFullName: "guchi-apps/car-care", number: 12 }],
    );

    expect(result.map((pr) => pr.number)).toEqual([5]);
  });
});

describe("canMergeFromDeck", () => {
  it("draft以外はCIの状態によらずマージ操作の対象にする", () => {
    expect(canMergeFromDeck(pullRequest({ ciState: "success" }))).toBe(true);
    expect(canMergeFromDeck(pullRequest({ ciState: "failure" }))).toBe(true);
    expect(canMergeFromDeck(pullRequest({ ciState: "pending" }))).toBe(true);
    expect(canMergeFromDeck(pullRequest({ autoMergeEnabled: true }))).toBe(true);
  });

  it("draftはGitHub側がマージを受け付けないため対象にしない", () => {
    expect(canMergeFromDeck(pullRequest({ draft: true }))).toBe(false);
  });

  it("コンフリクトしているPRは対象にしない（#1742）", () => {
    expect(canMergeFromDeck(pullRequest({ mergeable: false }))).toBe(false);
  });

  it("コンフリクトの判定が出ていないPRは従来どおり対象にする（#1742）", () => {
    expect(canMergeFromDeck(pullRequest({ mergeable: null }))).toBe(true);
    expect(canMergeFromDeck(pullRequest({ mergeable: true }))).toBe(true);
  });

  // 画面内のリンクからマージ済み・クローズ済みのPRも開けるようになったため（#1260）
  it("openでないPRは対象にしない", () => {
    expect(canMergeFromDeck(pullRequest({ state: "closed", merged: true }))).toBe(false);
    expect(canMergeFromDeck(pullRequest({ state: "closed", merged: false }))).toBe(false);
  });
});

describe("isMergeJudgementPending", () => {
  it("判定が走っている間だけ真になる（#1968）", () => {
    expect(isMergeJudgementPending({ state: "pending", step: null, runUrl: null })).toBe(true);
    expect(isMergeJudgementPending({ state: "settled", step: null, runUrl: null })).toBe(false);
    // 判定のワークフローが配られていないリポジトリまで塞がない。
    expect(isMergeJudgementPending({ state: "unknown", step: null, runUrl: null })).toBe(false);
  });

  it("待っている段階を画面の文言へ言い換える（#2059）", () => {
    expect(mergeJudgementLabel("claude-review")).toBe("Claudeがレビュー中");
    expect(mergeJudgementLabel("wait-for-ci")).toBe("CIの完了待ち");
    // 段階を特定できないときも「何かを判定中」だと分かる文言へ縮退させる。
    expect(mergeJudgementLabel(null)).toBe("マージ可否を判定中");
    expect(mergeJudgementReason("claude-review")).toContain("Claudeがレビュー中です");
    expect(mergeJudgementReason(null)).toContain("claude-review-develop");
  });

  it("判定中でも`mergeWarnings`は増やさない（止め方はボタンの無効化。#1968）", () => {
    const judging = pullRequest({
      ciState: "success",
      mergeJudgement: { state: "pending", step: null, runUrl: null },
    });
    expect(mergeWarnings(judging)).toEqual([]);
  });
});

describe("mergeWarnings", () => {
  it("CI通過済み・Auto-merge無効なら確認は不要", () => {
    expect(mergeWarnings(pullRequest({ ciState: "success" }))).toEqual([]);
  });

  it("CIの状態ごとに確認文言を返す", () => {
    expect(mergeWarnings(pullRequest({ ciState: "failure" }))).toEqual(["CIが失敗しています。"]);
    expect(mergeWarnings(pullRequest({ ciState: "pending" }))).toEqual(["CIがまだ実行中です。"]);
    expect(mergeWarnings(pullRequest({ ciState: "unknown" }))).toEqual([
      "CIの状態を確認できていません。",
    ]);
  });

  it("Auto-merge有効なPRは待てば自動でマージされることを伝える", () => {
    expect(mergeWarnings(pullRequest({ autoMergeEnabled: true }))).toEqual([
      "Auto-mergeが有効です。待てばCI通過後に自動でマージされます。",
    ]);
  });

  it("main宛のPRは、CIが通っていても本番デプロイが走ることを必ず伝える（#1548）", () => {
    expect(
      mergeWarnings(
        pullRequest({ baseRef: "main", headRef: "develop", kind: "release", ciState: "success" }),
      ),
    ).toEqual(["mainへのマージです。マージすると本番デプロイが走ります。"]);
  });

  it("main宛でCIも落ちている場合は両方返す（#1548）", () => {
    expect(
      mergeWarnings(
        pullRequest({ baseRef: "main", headRef: "develop", kind: "release", ciState: "failure" }),
      ),
    ).toEqual([
      "mainへのマージです。マージすると本番デプロイが走ります。",
      "CIが失敗しています。",
    ]);
  });

  it("CI未通過とAuto-merge有効は両方並べる", () => {
    expect(mergeWarnings(pullRequest({ ciState: "pending", autoMergeEnabled: true }))).toEqual([
      "CIがまだ実行中です。",
      "Auto-mergeが有効です。待てばCI通過後に自動でマージされます。",
    ]);
  });
});

describe("requiresUserMerge", () => {
  it("対応Issueに00.check-userが付いたIssue対応PRはユーザーのマージが必要", () => {
    expect(requiresUserMerge(pullRequest({ linkedIssueCheckUser: true }))).toBe(true);
  });

  it("対応Issueに00.check-userが無ければ出さない（判定がまだ確定していない）", () => {
    expect(requiresUserMerge(pullRequest({ linkedIssueCheckUser: false }))).toBe(false);
  });

  it("理由ラベルが読めるなら01.check-mergeのときだけ出す（#1490）", () => {
    expect(
      requiresUserMerge(
        pullRequest({ linkedIssueCheckUser: true, linkedIssueCheckReason: "merge" }),
      ),
    ).toBe(true);
  });

  it("理由が計画の承認待ち・質問の回答待ちなら出さない（#1490）", () => {
    for (const reason of ["plan", "input", "blocked", "answered"] as const) {
      expect(
        requiresUserMerge(
          pullRequest({ linkedIssueCheckUser: true, linkedIssueCheckReason: reason }),
        ),
      ).toBe(false);
    }
  });

  it("理由ラベルが配られていないリポジトリでは00.check-userの有無で判定する（#1490）", () => {
    expect(
      requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, linkedIssueCheckReason: null })),
    ).toBe(true);
  });

  it("develop→mainのリリースPRは常にユーザーのマージが必要", () => {
    expect(
      requiresUserMerge(
        pullRequest({
          kind: "release",
          baseRef: "main",
          headRef: "develop",
          linkedIssueNumber: null,
          linkedIssueCheckUser: false,
        }),
      ),
    ).toBe(true);
  });

  it("バージョンバンプPRはAuto-mergeでdevelopへ入るため出さない", () => {
    expect(
      requiresUserMerge(
        pullRequest({ kind: "version-bump", headRef: "release/v2.19.0", linkedIssueCheckUser: true }),
      ),
    ).toBe(false);
  });

  it("規約から外れたブランチのPRは判定材料が無いため出さない", () => {
    expect(
      requiresUserMerge(
        pullRequest({ kind: "other", headRef: "feature/foo", linkedIssueCheckUser: true }),
      ),
    ).toBe(false);
  });

  it("Auto-merge有効なPRは待てば入るため出さない", () => {
    expect(
      requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, autoMergeEnabled: true })),
    ).toBe(false);
  });

  it("ドラフト・クローズ済み・マージ済みには出さない", () => {
    expect(requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, draft: true }))).toBe(false);
    expect(requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, state: "closed" }))).toBe(
      false,
    );
    expect(
      requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, state: "closed", merged: true })),
    ).toBe(false);
  });

  it("CIの状態によらず出す（自動でマージされないことはCIの結果と無関係）", () => {
    for (const ciState of ["pending", "success", "failure", "unknown"] as const) {
      expect(requiresUserMerge(pullRequest({ linkedIssueCheckUser: true, ciState }))).toBe(true);
    }
  });
});

describe("applyOptimisticMerges", () => {
  it("マージしたPRをマージ済みへ差し替える（他のPRはそのまま）", () => {
    const merged = pullRequest({ id: "repo#1", number: 1 });
    const other = pullRequest({ id: "repo#2", number: 2 });

    const result = applyOptimisticMerges(
      [merged, other],
      [{ id: "repo#1", mergedAt: "2026-08-16T10:00:00.000Z" }],
    );

    expect(result[0]).toMatchObject({
      id: "repo#1",
      state: "closed",
      merged: true,
      mergedAt: "2026-08-16T10:00:00.000Z",
    });
    expect(result[1]).toBe(other);
  });

  it("マージ済みとして扱ったPRには画面からのマージボタンを出さない", () => {
    const [result] = applyOptimisticMerges(
      [pullRequest({ id: "repo#1", linkedIssueCheckUser: true })],
      [{ id: "repo#1", mergedAt: "2026-08-16T10:00:00.000Z" }],
    );

    expect(canMergeFromDeck(result)).toBe(false);
    expect(requiresUserMerge(result)).toBe(false);
    // openなPRだけを通す一覧からも消える（従来「伏せて」いたのと同じ結果）
    expect(filterPullRequestsByView([result], "all")).toEqual([]);
  });

  it("取得結果の方が進んでいる（既にclosed）場合は取得結果を正とする", () => {
    const closed = pullRequest({
      id: "repo#1",
      state: "closed",
      merged: false,
      mergedAt: null,
    });

    const [result] = applyOptimisticMerges(
      [closed],
      [{ id: "repo#1", mergedAt: "2026-08-16T10:00:00.000Z" }],
    );

    expect(result).toBe(closed);
  });

  it("対象が無ければ配列をそのまま返す", () => {
    const pullRequests = [pullRequest()];
    expect(applyOptimisticMerges(pullRequests, [])).toBe(pullRequests);
  });
});
