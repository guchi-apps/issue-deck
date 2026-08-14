// 01〜09番台の数字プレフィックスを持つラベル（"02.wip"など）は、かつてIssueの進行状況を
// 示すステップ運用として使われていた。#991 Phase 5（#1010）で廃止済みだが、導入前の世代の
// ラベルが残るリポジトリを取り込んだときに現れ得るため、判定自体は残してある
// （docs/multi-agent/labels.md参照）。
// 00番台はステップではなく「要対応」を示す横断的なフラグ用途（例: 00.check-user）として
// 現役で使われている。
const STATUS_STEP_PATTERN = /^0([1-9])\./;
const ATTENTION_PATTERN = /^00\./;

export const STATUS_STEP_MAX = 9;

export function matchStatusStep(labelName: string): number | null {
  const match = STATUS_STEP_PATTERN.exec(labelName);
  return match ? Number(match[1]) : null;
}

export function isAttentionLabel(labelName: string): boolean {
  return ATTENTION_PATTERN.test(labelName);
}

/** 00番台の要対応ラベル、または廃止済みの01〜09番台の進捗ラベルかどうかを判定する（人が選ぶ対象から外すため） */
export function isProgressLabel(labelName: string): boolean {
  return isAttentionLabel(labelName) || matchStatusStep(labelName) !== null;
}
