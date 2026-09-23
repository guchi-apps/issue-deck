import { describe, expect, it } from "vitest";

import { computeAppBadgeCount } from "@/lib/app-badge-count";
import type { ReleaseMergePendingCounts } from "@/lib/release-merge-pending";

function pending(ids: string[]): ReleaseMergePendingCounts {
  return { develop: 0, main: ids.length, total: ids.length, hasError: false, pullRequestIds: ids };
}

describe("computeAppBadgeCount（#3433）", () => {
  it("3つのバッジを合計する", () => {
    expect(
      computeAppBadgeCount({
        checkUserCount: 4,
        checkUserPullRequestIds: [],
        mergePending: pending(["a/b#1"]),
        releaseUncheckedCount: 2,
      }),
    ).toBe(7);
  });

  it("ホームとブランチに共通するPRは1件として数える", () => {
    expect(
      computeAppBadgeCount({
        checkUserCount: 4,
        checkUserPullRequestIds: ["a/b#1"],
        mergePending: pending(["a/b#1"]),
        releaseUncheckedCount: 2,
      }),
    ).toBe(6);
  });

  it("未取得（null）は0として扱う", () => {
    expect(
      computeAppBadgeCount({
        checkUserCount: 3,
        checkUserPullRequestIds: [],
        mergePending: null,
        releaseUncheckedCount: null,
      }),
    ).toBe(3);
  });
});
