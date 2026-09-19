import { afterEach, describe, expect, it } from "vitest";

import {
  buildMergedPullRequestQuery,
  clearMergedPullRequestCountCache,
  getMergedPullRequestCountCache,
  mergedPullRequestRangeKey,
  parseMergedPullRequestRangeKey,
  setMergedPullRequestCountCache,
} from "@/lib/github/merged-pr-count";

afterEach(() => clearMergedPullRequestCountCache());

describe("buildMergedPullRequestQuery", () => {
  it("今までの期間は>=で、ミリ秒を落とし、既定ブランチへ入ったPRだけを数える", () => {
    expect(
      buildMergedPullRequestQuery(
        {
          repositoryFullName: "guchi-apps/issue-deck",
          from: "2026-09-01T03:04:05.678Z",
          to: null,
        },
        "develop",
      ),
    ).toBe(
      "repo:guchi-apps/issue-deck is:pr is:merged base:develop merged:>=2026-09-01T03:04:05Z",
    );
  });

  it("終わりのある期間はA..Bにする", () => {
    expect(
      buildMergedPullRequestQuery(
        {
          repositoryFullName: "o/r",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-09-01T00:00:00.000Z",
        },
        "main",
      ),
    ).toContain("merged:2026-08-01T00:00:00Z..2026-09-01T00:00:00Z");
  });
});

describe("parseMergedPullRequestRangeKey", () => {
  it("キーの往復で同じ期間に戻る", () => {
    const range = { repositoryFullName: "o/r", from: "2026-08-01T00:00:00.000Z", to: null };
    expect(parseMergedPullRequestRangeKey(mergedPullRequestRangeKey(range))).toEqual(range);
  });

  it("クエリへ混ぜられる値は通さない", () => {
    expect(parseMergedPullRequestRangeKey("o/r|2026-08-01 is:open|")).toBeNull();
    expect(parseMergedPullRequestRangeKey("o/r x|2026-08-01T00:00:00Z|")).toBeNull();
    expect(parseMergedPullRequestRangeKey("o/r|2026-08-01T00:00:00Z")).toBeNull();
  });
});

describe("件数のキャッシュ", () => {
  const open = { repositoryFullName: "o/r", from: "2026-08-01T00:00:00.000Z", to: null };
  const closed = { ...open, to: "2026-09-01T00:00:00.000Z" };

  it("今までの期間は10分で捨て、終わりのある期間は持ち続ける", () => {
    setMergedPullRequestCountCache(open, "develop", 5, 0);
    setMergedPullRequestCountCache(closed, "develop", 7, 0);
    expect(getMergedPullRequestCountCache(open, "develop", 5 * 60 * 1000)).toBe(5);
    expect(getMergedPullRequestCountCache(open, "develop", 11 * 60 * 1000)).toBeNull();
    expect(getMergedPullRequestCountCache(closed, "develop", 24 * 60 * 60 * 1000)).toBe(7);
    // 既定ブランチが変わったら別物
    expect(getMergedPullRequestCountCache(closed, "main", 0)).toBeNull();
  });
});
