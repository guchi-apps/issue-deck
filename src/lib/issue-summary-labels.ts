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

/**
 * スマホのIssue詳細サマリーへ出すラベルを選ぶ（#1646）。
 *
 * ラベルは多いIssueで10件を超える。全部並べると、パッと見のために置いたサマリーが
 * ラベル一覧になってしまうため上限で切る。**要対応ラベル（`00.`・`01.check-*`）を先へ寄せる**
 * のは、切り捨てで消えてよい情報ではないため。同順位の並びは元の順序を保つ。
 *
 * 切り捨てたぶんは`hiddenCount`として返し、全部見たい場合はプロパティ（折りたたみ）で見る。
 */
export function selectSummaryLabels(
  labels: IssueLabel[],
  limit: number = SUMMARY_LABEL_LIMIT,
): SummaryLabels {
  const attention = labels.filter((label) => isAttentionLabel(label.name));
  const rest = labels.filter((label) => !isAttentionLabel(label.name));
  const sorted = [...attention, ...rest];
  return {
    visible: sorted.slice(0, limit),
    hiddenCount: Math.max(0, sorted.length - limit),
  };
}
