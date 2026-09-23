import { isAttentionLabel } from "@/lib/issue-status";
import type { IssueLabel } from "@/types/issue";

export type SelectSummaryLabelsOptions = {
  /**
   * 要対応ラベル（`00.`帯と`01.check-*`）を選択肢から外すか（#2057）。
   *
   * **確認待ちのバッジ（「確認待ち・PRのマージ」）を同じカードに出しているときだけtrueにする。**
   * バッジは`00.check-user`と`01.check-*`を日本語にしたものなので、両方出すと同じことを
   * 機械語で繰り返すだけになる。全ラベルはプロパティ（折りたたみ）に従来どおり並ぶ。
   */
  excludeAttention?: boolean;
};

/**
 * スマホのIssue詳細サマリーへ出すラベルを並べる（#1646・#3388）。
 *
 * 横スクロールで全件出すため件数の上限は設けない。**要対応ラベル（`00.`・`01.check-*`）を
 * 先へ寄せる**のは、横スクロールの奥に隠れる前に目に入ってほしいため
 * （`excludeAttention`でバッジへ任せる場合を除く）。同順位の並びは元の順序を保つ。
 */
export function selectSummaryLabels(
  labels: IssueLabel[],
  { excludeAttention = false }: SelectSummaryLabelsOptions = {},
): IssueLabel[] {
  const attention = excludeAttention ? [] : labels.filter((label) => isAttentionLabel(label.name));
  const rest = labels.filter((label) => !isAttentionLabel(label.name));
  return [...attention, ...rest];
}
