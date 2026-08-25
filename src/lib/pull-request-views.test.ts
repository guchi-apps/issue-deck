import { describe, expect, it } from "vitest";

import {
  getAdjacentPullRequestViewId,
  isPullRequestViewAttention,
  pullRequestViews,
} from "@/lib/pull-request-views";

describe("getAdjacentPullRequestViewId（#1691）", () => {
  it("表示順で隣のビューを返す", () => {
    expect(getAdjacentPullRequestViewId("all", "next")).toBe("in-progress");
    expect(getAdjacentPullRequestViewId("completed", "prev")).toBe("in-progress");
  });

  it("端のビューではそれ以上進めずnullを返す", () => {
    expect(getAdjacentPullRequestViewId("all", "prev")).toBeNull();
    expect(getAdjacentPullRequestViewId("completed", "next")).toBeNull();
  });

  it("先頭・末尾の判定は`pullRequestViews`の並びに従う", () => {
    const ids = pullRequestViews.map((view) => view.id);
    expect(getAdjacentPullRequestViewId(ids[0], "prev")).toBeNull();
    expect(getAdjacentPullRequestViewId(ids[ids.length - 1], "next")).toBeNull();
  });
});

describe("isPullRequestViewAttention（#2334）", () => {
  it("マージ待ちが1件以上あるときだけオレンジの丸にする", () => {
    expect(isPullRequestViewAttention("completed", 1)).toBe(true);
    expect(isPullRequestViewAttention("completed", 12)).toBe(true);
  });

  // 丸は「いま手を動かせるものがある」という合図なので、0に丸を付けると合図として読めない
  it("マージ待ちでも0件・未取得なら点けない", () => {
    expect(isPullRequestViewAttention("completed", 0)).toBe(false);
    expect(isPullRequestViewAttention("completed", null)).toBe(false);
  });

  // 「すべてのPR」は実行中を含む在庫の数、「実行中」は人が何もしなくても進むもの
  it("すべてのPR・実行中は件数があっても点けない", () => {
    expect(isPullRequestViewAttention("all", 9)).toBe(false);
    expect(isPullRequestViewAttention("in-progress", 9)).toBe(false);
  });
});
