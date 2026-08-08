/**
 * GitHub Actions実行中のClaude Codeステップ名から、一覧などに表示する簡易文言へのマッピング。
 * Checkoutや依存関係インストールなど対応がないステップ名にはnullを返し、呼び出し側で
 * カッコ書きの表示自体を省略する。
 */
const SIMPLE_STEP_LABELS: Record<string, string> = {
  "Claude Code（計画提示）": "AIが計画作成中",
  "Claude Code（実装・PR作成）": "AIが実装中",
  "Claude Code（分割）": "AIが分割中",
  "Claude Code（質問応答）": "AIが質問に回答中",
  "Claude Code（コンフリクト解消）": "AIがコンフリクト解消中",
  "Claude Code（CI失敗修正）": "AIがCI失敗を修正中",
  "Run Claude Code Review": "AIがレビュー中",
};

export function getSimpleStepLabel(stepName: string | null): string | null {
  if (stepName === null) return null;
  return SIMPLE_STEP_LABELS[stepName] ?? null;
}
