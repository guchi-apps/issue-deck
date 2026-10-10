import { describe, expect, it } from "vitest";

import { normalizeReleaseReview } from "./release-review-result";

describe("normalizeReleaseReview", () => {
  it("指摘も未確認範囲も無ければpassed", () => {
    const r = normalizeReleaseReview({ state: "passed", summary: "問題なし", reviewedFiles: 10, totalFiles: 10 });
    expect(r).toMatchObject({ state: "passed", unverifiedScope: null });
  });

  it("指摘が1件でもあればneeds_check（AIのLGTMだけで通さない）", () => {
    const r = normalizeReleaseReview({
      state: "passed",
      findings: [{ severity: "high", title: "設定漏れ", detail: "env", file: "a.ts", pullRequests: [3, 3, 4] }],
    });
    expect(r?.state).toBe("needs_check");
    expect(r?.detail.affectedPullRequests).toEqual([3, 4]);
  });

  it("確認できたファイルが差分より少なければ未確認範囲を付けてpassedのまま持つ", () => {
    const r = normalizeReleaseReview({ state: "passed", reviewedFiles: 30, totalFiles: 80 });
    expect(r?.state).toBe("passed");
    expect(r?.unverifiedScope).toContain("80ファイルのうち30");
  });

  it("failedはそのまま、不正な状態・本文はnull", () => {
    expect(normalizeReleaseReview({ state: "failed" })?.state).toBe("failed");
    expect(normalizeReleaseReview({ state: "weird" })).toBeNull();
    expect(normalizeReleaseReview(null)).toBeNull();
  });

  it("タイトルの無い指摘は捨てる", () => {
    const r = normalizeReleaseReview({ state: "passed", findings: [{ detail: "x" }, "bad"] });
    expect(r?.detail.findings).toEqual([]);
  });
});
