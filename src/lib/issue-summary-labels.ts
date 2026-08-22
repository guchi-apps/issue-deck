import { isAttentionLabel } from "@/lib/issue-status";
import type { IssueLabel } from "@/types/issue";

/** サマリーに出すラベルの既定件数。スマホの1行に収まる上限（#1646） */
export const SUMMARY_LABEL_LIMIT = 3;

export type SummaryLabels = {
  /** 実際に描くラベル */
  visible: IssueLabel[];
  /** 描かなかった件数（0なら「+N」を出さない） */
  hiddenCount: number;
};

export type SelectSummaryLabelsOptions = {
  /** 出す件数の上限 */
  limit?: number;
  /**
   * 要対応ラベル（`00.`帯と`01.check-*`）を選択肢から外すか（#2057）。
   *
   * **確認待ちのバッジ（「確認待ち・PRのマージ」）を同じカードに出しているときだけtrueにする。**
   * バッジは`00.check-user`と`01.check-*`を日本語にしたものなので、両方出すと同じことを
   * 機械語で繰り返すだけになり、上限3件の枠を2件使って分類ラベル（`60.chore`など）を
   * 「+N」の裏へ押し出していた。**外したぶんは`hiddenCount`に数えない**——隠したのではなく
   * バッジが代わりに言っているため。全ラベルはプロパティ（折りたたみ）に従来どおり並ぶ。
   */
  excludeAttention?: boolean;
};

/**
 * スマホのIssue詳細サマリーへ出すラベルを選ぶ（#1646）。
 *
 * ラベルは多いIssueで10件を超える。全部並べると、パッと見のために置いたサマリーが
 * ラベル一覧になってしまうため上限で切る。**要対応ラベル（`00.`・`01.check-*`）を先へ寄せる**
 * のは、切り捨てで消えてよい情報ではないため（`excludeAttention`でバッジへ任せる場合を除く）。
 * 同順位の並びは元の順序を保つ。
 *
 * 切り捨てたぶんは`hiddenCount`として返し、全部見たい場合はプロパティ（折りたたみ）で見る。
 */
export function selectSummaryLabels(
  labels: IssueLabel[],
  { limit = SUMMARY_LABEL_LIMIT, excludeAttention = false }: SelectSummaryLabelsOptions = {},
): SummaryLabels {
  const attention = excludeAttention ? [] : labels.filter((label) => isAttentionLabel(label.name));
  const rest = labels.filter((label) => !isAttentionLabel(label.name));
  const sorted = [...attention, ...rest];
  return {
    visible: sorted.slice(0, limit),
    hiddenCount: Math.max(0, sorted.length - limit),
  };
}
