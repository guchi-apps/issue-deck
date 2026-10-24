import { describe, expect, it } from "vitest";

import { recommendationFailureMessage } from "@/lib/claude/release-review-recommend";
import { readRetryAt } from "@/lib/claude/request";

describe("recommendationFailureMessage", () => {
  it("429は利用枠の上限と再取得できる時刻を伝える", () => {
    const retryAt = Date.parse("2026-10-23T05:20:00Z"); // JST 14:20
    const msg = recommendationFailureMessage(429, { code: null, requestId: null, retryAt });
    expect(msg).toContain("利用枠が上限");
    expect(msg).toContain("14:20");
  });

  it("429で時刻が不明なときは待つよう伝える", () => {
    expect(recommendationFailureMessage(429, null)).toContain("しばらく待って");
  });

  it("429以外はステータスを添える", () => {
    expect(recommendationFailureMessage(529, null)).toBe("AIの推奨を作れませんでした (529)");
  });
});

describe("readRetryAt", () => {
  it("retry-afterの秒数を優先する", () => {
    expect(readRetryAt(new Headers({ "retry-after": "60" }), 1000)).toBe(61000);
  });
  it("ヘッダが無ければnull", () => {
    expect(readRetryAt(new Headers(), 1000)).toBeNull();
  });
});
