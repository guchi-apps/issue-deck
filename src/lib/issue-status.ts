import { isCheckUserReasonLabel } from "@/lib/github/approval-labels";

// 01〜09番台の数字プレフィックスを持つラベル（"02.wip"など）は、かつてIssueの進行状況を
// 示すステップ運用として使われていた。#991 Phase 5（#1010）で廃止済みだが、導入前の世代の
// ラベルが残るリポジトリを取り込んだときに現れ得るため、判定自体は残してある
// （docs/multi-agent/labels.md参照）。
// 00番台はステップではなく「要対応」を示す横断的なフラグ用途（例: 00.check-user）として
// 現役で使われている。
const STATUS_STEP_PATTERN = /^0([1-9])\./;
const ATTENTION_PATTERN = /^00\./;

export const STATUS_STEP_MAX = 9;

/**
 * 廃止済みの進捗ステップラベルなら、そのステップ番号を返す。
 *
 * **`01.check-*`（`00.check-user`の理由ラベル。#1490）は番号の形が同じでもステップではない。**
 * 除外しないと詳細のラベル欄に「ステップ1/9」の進捗バーとツールチップが誤って描画される。
 */
export function matchStatusStep(labelName: string): number | null {
  if (isCheckUserReasonLabel(labelName)) return null;
  const match = STATUS_STEP_PATTERN.exec(labelName);
  return match ? Number(match[1]) : null;
}

/** 00番台の「要対応」ラベル、または`00.check-user`の理由を表す`01.check-*`ラベルかどうか */
export function isAttentionLabel(labelName: string): boolean {
  return ATTENTION_PATTERN.test(labelName) || isCheckUserReasonLabel(labelName);
}

/** 要対応ラベル、または廃止済みの01〜09番台の進捗ラベルかどうかを判定する（人が選ぶ対象から外すため） */
export function isProgressLabel(labelName: string): boolean {
  return isAttentionLabel(labelName) || matchStatusStep(labelName) !== null;
}
