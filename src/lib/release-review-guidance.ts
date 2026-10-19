import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/** 表示の助言。公開可否やAIの原判定を変更しない。 */
export type ReleaseGuidance = { title: string; next: string; kind: "attention" | "waiting" | "complete" };

export function describeReleaseGuidance(v: ReleaseVerificationSummary): ReleaseGuidance[] {
  const result: ReleaseGuidance[] = [];
  for (const [label, section] of [["統合検証", v.integration], ["全体レビュー", v.aiReview]] as const) {
    if (section.state === "failed") result.push({ kind: "attention", title: `${label}の実行に失敗しました`, next: label === "全体レビュー"
      ? "レビューの実行診断を開き、接続・権限・実行環境の原因を解消してから再実行してください。コードの不具合が見つかったこととは別です。"
      : "統合検証の失敗内容を開いてください。テストの不合格は修正し、設定・実行環境の不足は解消してから再検証します。" });
    else if (section.state === "invalidated" || section.state === "not_run") result.push({ kind: "attention", title: `${label}の有効な結果がありません`, next: "現在の候補を対象に検証する必要があります。下の検証詳細で依頼状態を確認してください。" });
    else if (section.state === "running" || section.state === "waiting") result.push({ kind: "waiting", title: `${label}の結果待ちです`, next: "下の実行状況を確認してください。実行中の処理を重ねて開始する必要はありません。" });
  }
  const review = v.aiReview;
  if (review.state === "needs_check" || review.state === "passed") {
    const decisions = review.decisions;
    const pending = decisions ? decisions.counts.undecidedBlocking : review.findings.length;
    if (pending > 0) result.push({ kind: "attention", title: `対応判断が必要な指摘 ${pending}件`, next: "全体レビューを開き、影響・根拠と対応案を確認してください。「今回直す」「公開後」「見送る」「不採用」を選べます。再実行だけでは指摘への判断は進みません。" });
    if (decisions && decisions.counts.fixNow > 0) result.push({ kind: "attention", title: `公開前に対応する指摘 ${decisions.counts.fixNow}件`, next: "修正の進行状況を確認してください。修正が未開始なら修正Issueを起案し、修正後の候補で再検証します。" });
    if (review.unverifiedScope?.trim() || (review.state === "needs_check" && review.findings.length === 0)) result.push({ kind: "attention", title: "確認できていない範囲があります", next: "未確認の理由を開いてください。検証結果待ちなら到着後の再評価、環境不足なら環境の解消、公開後にしか確認できない作業なら実施時期の判断が必要です。同じ条件で再実行を繰り返しても解消するとは限りません。" });
  }
  if (v.integration.state === "needs_check") result.push({ kind: "attention", title: "統合検証に確認事項があります", next: "統合検証の詳細で不足している検証・設定を確認してください。AIの指摘への判断では解除されません。" });
  if (v.mac.state === "failed" || v.mac.state === "needs_setup" || v.mac.state === "invalidated") result.push({ kind: "attention", title: "iOS検証に対応が必要です", next: "iOS検証の詳細でビルドの失敗・接続や設定の不足を確認してください。" });
  if (v.mac.state === "running") result.push({ kind: "waiting", title: "iOS検証の結果待ちです", next: "iOSでのビルド確認の結果を待っています。下の詳細で進行状況を確認してください。" });
  if (result.length === 0) result.push({ kind: "complete", title: "この画面の検証に対応待ちはありません", next: "公開内容と本番公開の条件を確認してください。公開を止めない改善提案への判断は任意です。公開承認・CIなど、他の公開条件は別途確認されます。" });
  return result;
}

/** AIが記録した事実を引用する入力補助。追加のAI推論・安全判定としては表示しない。 */
export function prepareFixReason(finding: ReleaseReviewFinding | undefined, blocking: boolean): string | null {
  if (!blocking || !finding?.impact?.trim() || !finding.evidence?.trim() || !finding.blockingReason?.trim()) return null;
  const excerpt = (value: string) => value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return `公開前に対応する。\n影響: ${excerpt(finding.impact)}\n根拠: ${excerpt(finding.evidence)}\n公開前に必要な理由: ${excerpt(finding.blockingReason)}`;
}
