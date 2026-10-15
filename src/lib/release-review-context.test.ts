import { describe, expect, it } from "vitest";

import { RELEASE_REVIEW_CHECKLIST_VERSION } from "./release-review-checklist";
import {
  buildReviewPromptContext,
  decideReviewMode,
  findingIdOfSeriesItem,
  type PreviousReviewRecord,
  type ReleaseFixHistory,
  type ReleaseReviewContextDecision,
} from "./release-review-context";
import { reviewFindingId } from "./release-review-result";

const current = { baseSha: "base1", headSha: "head2" };
const previous = (over: Partial<PreviousReviewRecord> = {}): PreviousReviewRecord => ({
  prNumber: 10,
  baseSha: "base1",
  headSha: "head1",
  state: "needs_check",
  checklistVersion: RELEASE_REVIEW_CHECKLIST_VERSION,
  checkStatuses: { auth_boundary: "confirmed" },
  findings: [{ id: "R-aaaaaa", title: "設定漏れ", file: "a.ts", line: 3, detail: "d", occurrences: 1 }],
  unverifiedScope: null,
  ...over,
});
const history: ReleaseFixHistory = {
  issueNumber: 50,
  fixPrNumber: 51,
  status: "fix_merged",
  items: [{ title: "設定漏れ", file: "a.ts:3", detail: "d" }],
  findings: [{ key: "F-001", title: "設定漏れ", status: "resolved", resolution: "テストで確認", reopenCount: 0 }],
};

describe("decideReviewMode", () => {
  it("前回の記録・版・baseが揃い履歴を辿れれば再レビュー", () => {
    expect(decideReviewMode({ current, previous: previous(), histories: [history] })).toEqual({ mode: "rereview", reason: null });
  });

  it.each([
    ["前回の記録が無い", null, [history], "記録が無い"],
    ["前回が実行失敗", previous({ state: "failed" }), [history], "完走していない"],
    ["旧ランナーの結果（履歴欠落）", previous({ checklistVersion: null }), [history], "項目別の確認記録が無い"],
    ["確認項目の版が変わった", previous({ checklistVersion: RELEASE_REVIEW_CHECKLIST_VERSION + 1 }), [history], "版が変わった"],
    ["baseが変わった", previous({ baseSha: "other" }), [history], "base"],
    ["修正の履歴を辿れない", previous(), [], "履歴を辿れない"],
  ] as const)("%s → 全体確認へ戻す", (_name, prev, histories, reason) => {
    const decision = decideReviewMode({ current, previous: prev, histories: [...histories] });
    expect(decision.mode).toBe("initial");
    expect(decision.reason).toContain(reason);
  });
});

describe("buildReviewPromptContext", () => {
  it("修正PR番号・修正Issueの対応・前回の指摘を束ね、系列の項目を同じ導出関数で指摘IDへ突き合わせる", () => {
    const id = reviewFindingId({ title: "設定漏れ", file: "a.ts", line: 3 });
    expect(findingIdOfSeriesItem(history.items[0])).toBe(id);
    const ctx = buildReviewPromptContext({
      current,
      previous: previous({ findings: [{ id, title: "設定漏れ", file: "a.ts", line: 3, detail: "d", occurrences: 1 }] }),
      histories: [history],
    });
    expect(ctx.mode).toBe("rereview");
    expect(ctx.fixPrNumbers).toEqual([51]);
    expect(ctx.fixIssueByFinding[id]).toBe(50);
    expect(ctx.fixHistory[0].findings[0].resolution).toBe("テストで確認");
    expect(ctx.previous).toMatchObject({ headSha: "head1", runFailed: false });
  });

  it("前回が失敗でも指摘と実行障害の事実は文脈に残す（全体確認）", () => {
    const ctx = buildReviewPromptContext({ current, previous: previous({ state: "failed" }), histories: [history] });
    expect(ctx.mode).toBe("initial");
    expect(ctx.previous?.runFailed).toBe(true);
  });
});

describe("ユーザー判断を文脈へ渡す（#4657）", () => {
  const id = findingIdOfSeriesItem({ title: "設定漏れ", file: "a.ts:3" });
  const decision = (over: Partial<ReleaseReviewContextDecision> = {}): ReleaseReviewContextDecision => ({
    id,
    title: "設定漏れ",
    decision: "post_release",
    reason: "公開後に配布",
    impact: null,
    scope: null,
    timing: "公開直後",
    followUp: "o/r#4651",
    stale: false,
    ...over,
  });
  const prev = () => previous({ findings: [{ id, title: "設定漏れ", file: "a.ts", line: 3, detail: "d", occurrences: 1 }] });

  it("有効な非修正の判断は前回の指摘から外し、判断として渡す", () => {
    const ctx = buildReviewPromptContext({ current, previous: prev(), histories: [history], decisions: [decision()] });
    expect(ctx.previousFindings).toHaveLength(0);
    expect(ctx.decidedFindingIds).toEqual([id]);
    expect(ctx.decisions[0]).toMatchObject({ id, decision: "post_release" });
  });

  it("「今回直す」・前提が変わった判断は、従来どおり前回の指摘として解消を確認する", () => {
    for (const d of [decision({ decision: "fix_now" }), decision({ stale: true })]) {
      const ctx = buildReviewPromptContext({ current, previous: prev(), histories: [history], decisions: [d] });
      expect(ctx.previousFindings.map((f) => f.id)).toEqual([id]);
      expect(ctx.decidedFindingIds).toEqual([]);
    }
  });
});
