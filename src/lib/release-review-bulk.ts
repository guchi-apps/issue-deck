import {
  RELEASE_REVIEW_DECISION_KINDS,
  validateDecisionInput,
  type ReleaseReviewDecisionKind,
  type ReleaseReviewDecisionSummary,
} from "@/lib/release-review-decision";
import { draftToDecisionInput, type ReleaseReviewRecommendation } from "@/lib/release-review-recommendation";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";

/**
 * 全体レビューの指摘を、AIの推奨でまとめて確定する（#5138）。**純関数だけ**を置き、画面（判定表）と
 * 一括確定API（`POST /api/repositories/release/review-decisions/bulk`）の両方から使う。
 *
 * - 対象は未判断（と前提が変わった判断）の指摘。止める指摘は全件、改善提案は推奨をそのまま使えるものだけ
 *   （改善提案は公開を止めないので、推奨が無ければ未判断のまま残す）
 * - 初期値は推奨。推奨が無い・推奨の必須項目（公開後対応の題・時期、見送りの影響・範囲）が欠けている止める指摘は、
 *   安全側の「今回直す」にし、理由は固定文`RELEASE_REVIEW_BULK_FALLBACK_REASON`を使う（理由の出どころは`fallback`）
 * - 選び直せる判断は、AIの理由案で必須項目が揃うものと「今回直す」だけ（推測で必須項目を埋めて保存しない）
 */

export const RELEASE_REVIEW_BULK_FALLBACK_REASON = "AIの推奨を得られなかったため、安全側で今回直す";

/** 一度に確定する上限。全体レビューの指摘は通常これより十分少ない */
export const RELEASE_REVIEW_BULK_MAX_ITEMS = 50;

export type BulkFallbackCause = "no_recommendation" | "incomplete";

export type BulkDecisionRow = {
  findingId: string;
  title: string;
  severity: ReleaseReviewFinding["severity"];
  blocking: boolean;
  /** 画面が見ていた最新の判断（競合の確認に使う）。判断の記録が無ければnull */
  expectedDecisionId: string | null;
  recommendation: ReleaseReviewRecommendation | null;
  /** 選べる判断 */
  options: ReleaseReviewDecisionKind[];
  /** 初期値 */
  decision: ReleaseReviewDecisionKind;
  /** 初期値が推奨でないとき、その理由 */
  fallback: BulkFallbackCause | null;
};

/** 判断APIへ送る1件（一括確定の`items`の要素） */
export type BulkDecisionItem = {
  findingId: string;
  expectedDecisionId: string | null;
  recommendationId: string | null;
  decision: ReleaseReviewDecisionKind;
  reason: string;
  impact: string | null;
  scope: string | null;
  timing: string | null;
  followUp: { kind: "create"; title: string } | null;
  /** 推奨を使えなかった指摘を「今回直す」で確定するときtrue。サーバーが固定文の理由を使う */
  fallback: boolean;
};

/** 推奨の理由案で、その判断の必須項目が揃うか */
function draftComplete(rec: ReleaseReviewRecommendation, kind: ReleaseReviewDecisionKind): boolean {
  return validateDecisionInput(draftToDecisionInput(kind, rec.drafts[kind])) === null;
}

export function bulkOptions(rec: ReleaseReviewRecommendation | null): ReleaseReviewDecisionKind[] {
  return RELEASE_REVIEW_DECISION_KINDS.filter((kind) => kind === "fix_now" || (rec !== null && draftComplete(rec, kind)));
}

export function buildBulkDecisionRows(input: {
  findings: readonly ReleaseReviewFinding[];
  suggestions: readonly ReleaseReviewFinding[];
  decisions: ReleaseReviewDecisionSummary | null;
  recommendations: Readonly<Record<string, ReleaseReviewRecommendation>>;
}): BulkDecisionRow[] {
  const rows: BulkDecisionRow[] = [];
  const add = (finding: ReleaseReviewFinding, blocking: boolean) => {
    const id = finding.id;
    if (!id) return;
    const view = input.decisions?.byFinding[id];
    if (view?.current && !view.stale) return;
    const rec = input.recommendations[id] ?? null;
    const usable = rec !== null && draftComplete(rec, rec.recommended);
    // 改善提案は公開を止めない。推奨をそのまま使えなければ、判断を作らず未判断のまま残す
    if (!blocking && !usable) return;
    rows.push({
      findingId: id,
      title: finding.title,
      severity: finding.severity,
      blocking,
      expectedDecisionId: view?.history.at(-1)?.id ?? null,
      recommendation: rec,
      options: bulkOptions(rec),
      decision: usable ? rec.recommended : "fix_now",
      fallback: usable ? null : rec ? "incomplete" : "no_recommendation",
    });
  };
  for (const finding of input.findings) add(finding, true);
  for (const suggestion of input.suggestions) add(suggestion, false);
  return rows;
}

/** 表で選んだ判断から、判断APIへ送る1件を作る。選べない判断（理由案の必須項目が欠ける）はnull */
export function toBulkDecisionItem(row: BulkDecisionRow, kind: ReleaseReviewDecisionKind): BulkDecisionItem | null {
  const rec = row.recommendation;
  if (rec && draftComplete(rec, kind)) {
    const input = draftToDecisionInput(kind, rec.drafts[kind]);
    return { findingId: row.findingId, expectedDecisionId: row.expectedDecisionId, recommendationId: rec.id, ...input, fallback: false };
  }
  if (kind !== "fix_now") return null;
  return {
    findingId: row.findingId,
    expectedDecisionId: row.expectedDecisionId,
    recommendationId: null,
    decision: "fix_now",
    reason: RELEASE_REVIEW_BULK_FALLBACK_REASON,
    impact: null,
    scope: null,
    timing: null,
    followUp: null,
    fallback: true,
  };
}

/** 判定ごとの件数（表の上の集計） */
export function countBulkDecisions(choices: readonly ReleaseReviewDecisionKind[]): Record<ReleaseReviewDecisionKind, number> {
  const counts: Record<ReleaseReviewDecisionKind, number> = { fix_now: 0, post_release: 0, defer: 0, reject: 0 };
  for (const kind of choices) counts[kind] += 1;
  return counts;
}
