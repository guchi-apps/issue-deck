/**
 * リポジトリ全体のコードレビュー（#698）の対象から外すリポジトリ（#3453）。
 *
 * レビューは「指摘→Issueを起案→そのIssueで実装して直す」流れの入口で、指摘カードの
 * 「Issueを作成」まで持っている。ここに並べるのは**無人実行を入れない枠**
 * （`docs/supported-repositories.md`）のリポジトリで、どれもその流れを想定していない。
 *
 * - `docs`: 共有知識。内容は格上げ判定エージェントがフリートの知見メモから反映する
 * - `claude-config`: 個人設定。`develop`を持たず、`issue-<番号>`→`main`の直行
 * - `vps`・`subpc`: 実機の設定。`main`へ入ると`deploy.yml`が実機へ反映する
 *
 * **リポジトリ名の固定リストで持つ。** `Repository`に種別の列は無く、近い列の
 * `hasClaudeWorkflow`（無人実行の有無）で絞ると`question`のような別の理由で入れていない
 * ものまで外れる。同じ枠のリポジトリを増やしたらここへも足す。
 */
export const CODE_REVIEW_EXCLUDED_REPOSITORIES: readonly string[] = [
  "guchi-apps/docs",
  "guchi-apps/claude-config",
  "guchi-apps/vps",
  "guchi-apps/subpc",
];

export function isCodeReviewExcludedRepository(repositoryFullName: string): boolean {
  return CODE_REVIEW_EXCLUDED_REPOSITORIES.includes(repositoryFullName);
}
