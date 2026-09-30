import { describe, expect, it } from "vitest";

import {
  PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES,
  decidePromotionMerge,
  promotionMergeIntervalMinutes,
} from "@/lib/github/knowledge-promotion-merge";

describe("decidePromotionMerge", () => {
  it("cleanだけマージする", () => {
    expect(decidePromotionMerge({ mergeable_state: "clean" })).toBe("merge");
    expect(decidePromotionMerge({ mergeable_state: "has_hooks" })).toBe("merge");
  });
  it("判定待ちは見送って次の巡回で見直す", () => {
    expect(decidePromotionMerge({ mergeable_state: "unknown" })).toBe("skip_pending");
    expect(decidePromotionMerge({ mergeable_state: null })).toBe("skip_pending");
  });
  it("失敗・コンフリクト・ブロック・ドラフトはマージしない", () => {
    for (const state of ["unstable", "dirty", "blocked", "behind"]) {
      expect(decidePromotionMerge({ mergeable_state: state })).toBe("skip_blocked");
    }
    expect(decidePromotionMerge({ draft: true, mergeable_state: "clean" })).toBe("skip_blocked");
  });
});

describe("promotionMergeIntervalMinutes", () => {
  it("未設定・不正は既定値、0は停止", () => {
    expect(promotionMergeIntervalMinutes(undefined)).toBe(PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES);
    expect(promotionMergeIntervalMinutes("abc")).toBe(PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES);
    expect(promotionMergeIntervalMinutes("0")).toBe(0);
    expect(promotionMergeIntervalMinutes("5")).toBe(5);
  });
});
