import { describe, expect, it } from "vitest";

import { classifyReleaseContents } from "@/lib/release-contents";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

const pr = (number: number, isVersionBump = false): ReleaseChangePullRequest => ({
  number,
  title: `PR${number}`,
  issueNumber: null,
  isVersionBump,
  review: null,
  prHeadSha: null,
  reviewUnavailable: false,
});
const base = { isLoading: false, error: null, addedPrNumbers: [], excludedPrNumbers: [] };

describe("classifyReleaseContents", () => {
  it("元の変更＋修正A＋未選択の無関係B: Bを含めず、Aは追加として区別する", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(1), pr(2), pr(100, true)], unknownCommits: [], truncated: false },
      addedPrNumbers: [2],
      excludedPrNumbers: [3],
    });
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.original.map((p) => p.number)).toEqual([1]);
    expect(r.added.map((p) => p.number)).toEqual([2]);
    expect(r.excluded).toEqual([3]);
  });

  it("差分に載っているPRは、記録で含めないとあっても含める側が正", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(3)], unknownCommits: [], truncated: false },
      excludedPrNumbers: [3],
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.excluded).toEqual([]);
  });

  it("取得中・失敗は変更なしにしない。PR不明・打ち切りは保持する", () => {
    expect(classifyReleaseContents({ ...base, changes: null }).kind).toBe("loading");
    expect(classifyReleaseContents({ ...base, changes: null, error: "x" }).kind).toBe("error");
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [], unknownCommits: [{ sha: "a", title: "t" }], truncated: true },
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.unknownCommits).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});
