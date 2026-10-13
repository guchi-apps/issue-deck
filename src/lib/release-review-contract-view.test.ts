import { describe, expect, it } from "vitest";

import { countOpenItems, describeCheck, describeReviewKind, describeStall, findingTags } from "./release-review-contract-view";
import type { ReleaseReviewMeta } from "./release-review-result";

const meta = (over: Partial<ReleaseReviewMeta> = {}): ReleaseReviewMeta => ({
  checklistVersion: 1,
  legacy: false,
  mode: "rereview",
  fullReviewReason: null,
  recheckScope: null,
  previous: null,
  fixDiffFileCount: null,
  addedPullRequests: [],
  checks: [],
  previousFindings: [],
  ...over,
});

describe("確認契約の表示文言", () => {
  it("初回／再レビューと版、旧ランナーの結果を区別する", () => {
    expect(describeReviewKind(meta({ mode: "initial" })).label).toBe("初回の全体確認");
    expect(describeReviewKind(meta()).version).toBe("確認項目 v1");
    expect(describeReviewKind(meta({ legacy: true, checklistVersion: null })).version).toContain("旧ランナー");
  });

  it("引き継いだ結果と今回確認した結果を区別し、旧SHAを明記する", () => {
    const sha = (s: string) => s.slice(0, 7);
    const carried = describeCheck(
      { id: "auth_boundary", status: "confirmed", evidence: "変更なし", source: "carried_over", carriedFromHeadSha: "abcdef123456" },
      sha,
    );
    expect(carried.source).toContain("前回から引き継ぎ");
    expect(carried.source).toContain("abcdef1");
    const current = describeCheck({ id: "auth_boundary", status: "confirmed", evidence: "e", source: "current", carriedFromHeadSha: null }, sha);
    expect(current.source).toBe("今回確認");
  });

  it("再発・新規・解消されない原因を出し、未解決件数を数える", () => {
    expect(findingTags({ id: "R-1", status: "recurring", occurrences: 3 } as never)).toEqual(["R-1", "再発（3回目）"]);
    expect(findingTags({ id: "R-2", status: "new", discovery: "fix_induced" } as never)).toEqual(["R-2", "新規・修正由来"]);
    expect(describeStall({ status: "recurring", stallCause: "unfixed" } as never)?.cause).toBe("未修正");
    expect(describeStall({ status: "new" } as never)).toBeNull();
    const review = meta({
      checks: [{ id: "x", status: "unconfirmed", evidence: "", source: "current", carriedFromHeadSha: null }],
      previousFindings: [{ id: "R-1", title: "t", status: "not_checked", evidence: null }],
    });
    expect(countOpenItems(review, [{} as never])).toEqual({ blocking: 1, unconfirmed: 1, unresolvedPrevious: 1 });
  });
});
