import { describe, expect, it } from "vitest";

import {
  notesForTarget,
  parseReviewNoteTarget,
  validateReviewNoteInput,
  type ReleaseReviewNoteRecord,
} from "@/lib/release-review-note";
import { summarizeReleaseReviewDecisions } from "@/lib/release-review-decision";

const rec = (id: string, target: ReleaseReviewNoteRecord["target"]): ReleaseReviewNoteRecord => ({
  id,
  target,
  body: "b",
  followUp: null,
  prNumber: 1,
  baseSha: "a",
  headSha: "b",
  author: "u",
  createdAt: "2026-11-08T00:00:00.000Z",
});

describe("判断メモ（#5252）", () => {
  it("理由だけが必須で、長さの上限を超えると弾く", () => {
    expect(validateReviewNoteInput({ body: " ", followUp: null })?.field).toBe("body");
    expect(validateReviewNoteInput({ body: "理由", followUp: null })).toBeNull();
    expect(validateReviewNoteInput({ body: "x".repeat(2001), followUp: null })?.field).toBe("body");
    expect(validateReviewNoteInput({ body: "理由", followUp: "y".repeat(301) })?.field).toBe("followUp");
  });

  it("対象は確認項目か候補全体だけを受け付ける", () => {
    expect(parseReviewNoteTarget({ kind: "overall" })).toEqual({ kind: "overall" });
    expect(parseReviewNoteTarget({ kind: "check", checkId: "auth_boundary" })).toEqual({ kind: "check", checkId: "auth_boundary" });
    expect(parseReviewNoteTarget({ kind: "check", checkId: "../x" })).toBeNull();
    expect(parseReviewNoteTarget({ kind: "finding" })).toBeNull();
    expect(parseReviewNoteTarget(null)).toBeNull();
  });

  it("対象ごとにメモを絞る", () => {
    const notes = { records: [rec("1", { kind: "overall" }), rec("2", { kind: "check", checkId: "auth_boundary" }), rec("3", { kind: "check", checkId: "x" })] };
    expect(notesForTarget(notes, { kind: "check", checkId: "auth_boundary" }).map((r) => r.id)).toEqual(["2"]);
    expect(notesForTarget(notes, { kind: "overall" }).map((r) => r.id)).toEqual(["1"]);
    expect(notesForTarget(null, { kind: "overall" })).toEqual([]);
  });

  it("メモは判断の集計の入力に無く、未確認範囲が残る限り解除にならない（合否へ影響しない）", () => {
    const summary = summarizeReleaseReviewDecisions({
      records: [],
      findings: [],
      suggestions: [],
      current: { baseSha: "a" },
      state: "needs_check",
      unverifiedScope: "auth_boundary未確認",
    });
    expect(summary.cleared).toBe(false);
    expect(summary.next).toContain("判断では解除できない");
    expect(summary.next).toContain("記録だけ");
  });
});
