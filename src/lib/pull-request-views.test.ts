import { describe, expect, it } from "vitest";

import { getAdjacentPullRequestViewId, pullRequestViews } from "@/lib/pull-request-views";

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
