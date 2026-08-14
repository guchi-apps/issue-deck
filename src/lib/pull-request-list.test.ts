import { describe, expect, it } from "vitest";

import {
  classifyPullRequest,
  extractLinkedIssueNumber,
  filterPullRequestsByView,
  groupPullRequestsByRepository,
  canMergeFromDeck,
  mergeWarnings,
  scopeForPullRequestView,
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
    baseRef: "develop",
    headRef: "issue-1",
    kind: "issue",
    linkedIssueNumber: 1,
    autoMergeEnabled: false,
    ciState: "success",
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
  it("allはクローズ済みも含めてそのまま返す", () => {
    const pullRequests = [
      pullRequest({ number: 1 }),
      pullRequest({ number: 2, state: "closed", merged: true, ciState: "unknown" }),
    ];
    expect(filterPullRequestsByView(pullRequests, "all")).toEqual(pullRequests);
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

describe("scopeForPullRequestView", () => {
  it("クローズ済みまで取りに行くのは全てのPRビューだけ", () => {
    expect(scopeForPullRequestView("all")).toBe("all");
    expect(scopeForPullRequestView("in-progress")).toBe("open");
    expect(scopeForPullRequestView("completed")).toBe("open");
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

  // 画面内のリンクからマージ済み・クローズ済みのPRも開けるようになったため（#1260）
  it("openでないPRは対象にしない", () => {
    expect(canMergeFromDeck(pullRequest({ state: "closed", merged: true }))).toBe(false);
    expect(canMergeFromDeck(pullRequest({ state: "closed", merged: false }))).toBe(false);
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

  it("CI未通過とAuto-merge有効は両方並べる", () => {
    expect(mergeWarnings(pullRequest({ ciState: "pending", autoMergeEnabled: true }))).toEqual([
      "CIがまだ実行中です。",
      "Auto-mergeが有効です。待てばCI通過後に自動でマージされます。",
    ]);
  });
});
