import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCodeReviewSummaryCache,
  CODE_REVIEW_SUMMARY_CACHE_TTL_MS,
  CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS,
  codeReviewSummaryCacheKey,
  getCodeReviewSummaryCache,
  setCodeReviewSummaryCache,
} from "@/lib/github/code-review-report-cache";
import type { CodeReviewSummary } from "@/lib/github/code-review";

const reported: CodeReviewSummary = {
  state: "reported",
  counts: { high: 1, medium: 2, low: 0 },
  findingCount: 3,
};
const pending: CodeReviewSummary = {
  state: "pending",
  counts: { high: 0, medium: 0, low: 0 },
  findingCount: 0,
};

const key = codeReviewSummaryCacheKey("guchi-apps", "issue-deck", 2440);

describe("code-review-report-cache", () => {
  beforeEach(() => {
    clearCodeReviewSummaryCache();
  });

  it("コメント件数が同じでTTL内なら再利用する", () => {
    setCodeReviewSummaryCache(key, { summary: reported, commentCount: 3 }, 1_000);
    expect(getCodeReviewSummaryCache(key, 3, 2_000)).toEqual(reported);
  });

  it("コメントが増えていれば使わない（結果が返った可能性がある）", () => {
    setCodeReviewSummaryCache(key, { summary: pending, commentCount: 1 }, 1_000);
    expect(getCodeReviewSummaryCache(key, 2, 1_100)).toBeNull();
  });

  it("結果が返っていないエントリは短いTTLで確認し直す", () => {
    setCodeReviewSummaryCache(key, { summary: pending, commentCount: 1 }, 0);
    expect(getCodeReviewSummaryCache(key, 1, CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS - 1)).toEqual(
      pending,
    );
    expect(getCodeReviewSummaryCache(key, 1, CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS)).toBeNull();
  });

  it("結果が返っているエントリは長いTTLまで持つ", () => {
    setCodeReviewSummaryCache(key, { summary: reported, commentCount: 3 }, 0);
    expect(
      getCodeReviewSummaryCache(key, 3, CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS + 1),
    ).toEqual(reported);
    expect(getCodeReviewSummaryCache(key, 3, CODE_REVIEW_SUMMARY_CACHE_TTL_MS)).toBeNull();
  });

  it("未キャッシュのキーはnull", () => {
    expect(getCodeReviewSummaryCache(key, 1)).toBeNull();
  });
});
