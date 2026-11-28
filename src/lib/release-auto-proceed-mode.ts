import { isIntegrationEnvironmentFailure } from "@/lib/release-integration-environment";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/**
 * 「次の操作」パネルの出し方（#5369）。新方式の候補では、修正の自動継続の入口をこのパネル1つにまとめ、
 * 旧「修正を自動で続ける」の開始ボタンは出さない。
 *
 * - `table`: 未判断の止める指摘がある。判定表を見せ、一括確定してから系列を始める（#5138）
 * - `start`: 判断済みで「今回直す」指摘が残る、または統合検証が失敗した。表なしで系列を始める
 * - `unresolvable`: 指摘0件で、再評価を終えても全体レビューの要確認だけが残った。直すコードが無く、系列を
 *   始めても同じ理由で止まるため、ボタンを出さずに再実行・判断の欄へ案内する。文言は原因別に出し分け、
 *   他リポジトリが原因なら利用側への確認Issueの下書きを出す（#5378。`describeUnresolvableCause`）
 * - `environment`: 統合検証の失敗が環境の不足（DB未起動・ツール無し。`P1001`など）。直すコードが無く、
 *   自動修正を始めても空振りするので、ボタンを出さずに再実行・実行ホストの変更へ案内する（#5561）
 * - `null`: 出さない（系列が動いている・直すものが無い・全体レビューの実行中や再評価中）
 */
export type AutoProceedMode = "table" | "start" | "unresolvable" | "environment";

export function decideAutoProceedMode(verification: ReleaseVerificationSummary | null, runActive: boolean): AutoProceedMode | null {
  if (!verification || runActive) return null;
  const review = verification.aiReview;
  const counts = review.decisions?.counts;
  if (review.state === "needs_check" && (counts?.undecidedBlocking ?? 0) > 0) return "table";
  if (verification.integration.state === "failed") {
    const { summary, reason } = verification.integration;
    return isIntegrationEnvironmentFailure(`${summary ?? ""}\n${reason ?? ""}`) ? "environment" : "start";
  }
  if (review.state === "needs_check" && (counts?.fixNow ?? 0) > 0) return "start";
  if (review.state === "needs_check" && review.findings.length === 0 && review.stage?.kind === "needs_check") return "unresolvable";
  return null;
}
