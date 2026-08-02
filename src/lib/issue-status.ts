// "01.wip" のように2桁の数字プレフィックスを持つラベルは、Issueの進行状況を示す
// ステップ運用（docs/multi-agent-workflow.md参照）として使われることが多い。
// 00番台のみステップではなく「要対応」を示す横断的なフラグ用途（例: 00.check-user）
// として扱う。
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
