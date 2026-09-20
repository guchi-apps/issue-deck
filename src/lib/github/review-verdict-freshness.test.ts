import { describe, expect, it } from "vitest";

import {
  buildReviewVerdictFreshnessNotice,
  resolveReviewVerdictFreshness,
  reviewVerdictFreshnessText,
  shortSha,
} from "@/lib/github/review-verdict-freshness";

const REVIEWED = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("resolveReviewVerdictFreshness", () => {
  it("判定時点のコミットがheadと同じなら`current`", () => {
    expect(resolveReviewVerdictFreshness({ reviewedSha: REVIEWED, headSha: REVIEWED })).toBe(
      "current",
    );
  });

  it("大文字小文字が違っても同じコミットとして扱う", () => {
    expect(
      resolveReviewVerdictFreshness({ reviewedSha: REVIEWED.toUpperCase(), headSha: REVIEWED }),
    ).toBe("current");
  });

  it("判定の後にコミットが積まれていれば`stale`", () => {
    expect(resolveReviewVerdictFreshness({ reviewedSha: REVIEWED, headSha: HEAD })).toBe("stale");
  });

  it("どちらかが分からなければ`unknown`（「古い」へ倒さない）", () => {
    expect(resolveReviewVerdictFreshness({ reviewedSha: null, headSha: HEAD })).toBe("unknown");
    expect(resolveReviewVerdictFreshness({ reviewedSha: REVIEWED, headSha: null })).toBe("unknown");
    expect(resolveReviewVerdictFreshness({ reviewedSha: undefined, headSha: undefined })).toBe(
      "unknown",
    );
  });
});

describe("buildReviewVerdictFreshnessNotice", () => {
  it("`unknown`では何も出さない", () => {
    expect(
      buildReviewVerdictFreshnessNotice({
        freshness: "unknown",
        reviewedSha: null,
        headSha: HEAD,
      }),
    ).toBeNull();
  });

  it("最新に対する判定では、そのコミットを短縮形で添える", () => {
    const notice = buildReviewVerdictFreshnessNotice({
      freshness: "current",
      reviewedSha: REVIEWED,
      headSha: REVIEWED,
    });

    expect(notice?.freshness).toBe("current");
    expect(notice?.parts.map((part) => part.text).join("")).toBe(
      `最新のコミット ${shortSha(REVIEWED)} に対する判定です。`,
    );
    // SHAだけを等幅で描けるように、断片として分けて返す
    expect(notice?.parts.filter((part) => part.mono).map((part) => part.text)).toEqual([
      shortSha(REVIEWED),
    ]);
  });

  it("古い判定では、判定時点と最新の両方を出す", () => {
    const text = reviewVerdictFreshnessText({
      freshness: "stale",
      reviewedSha: REVIEWED,
      headSha: HEAD,
    });

    expect(text).toContain("この判定の後にコミットが積まれています");
    expect(text).toContain(`判定時点 ${shortSha(REVIEWED)}`);
    expect(text).toContain(`最新 ${shortSha(HEAD)}`);
  });

  it("headを持たない画面では、判定時点だけを出す", () => {
    const text = reviewVerdictFreshnessText({ freshness: "stale", reviewedSha: REVIEWED });

    expect(text).toContain(`判定時点 ${shortSha(REVIEWED)}`);
    expect(text).not.toContain("最新 ");
  });

  it("判定時点のコミットが無ければ、鮮度を言わない", () => {
    expect(
      buildReviewVerdictFreshnessNotice({ freshness: "stale", reviewedSha: null, headSha: HEAD }),
    ).toBeNull();
  });
});
