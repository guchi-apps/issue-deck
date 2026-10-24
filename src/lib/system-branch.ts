/**
 * 専用の経路がマージするシステムブランチの接頭辞（#4952）。対応Issueを持たないPRのうち、これらだけは
 * `claude-review-develop.yml`が自動マージしない（リリース・タグ配布・復旧の流れがそれぞれマージする）。
 *
 * **ワークフローの`SYSTEM_BRANCH_PATTERN`と対**で、テストがYAML本文を読んで一致を確かめる。
 */
export const SYSTEM_BRANCH_PREFIXES = [
  "release",
  "release-sync",
  "release-rc",
  "release-main",
  "release-candidate",
  "release-bump",
  "workflow-tag",
  "deploy-recovery",
  "dependabot",
] as const;

export function isSystemBranch(headRef: string): boolean {
  return SYSTEM_BRANCH_PREFIXES.some((prefix) => headRef.startsWith(`${prefix}/`));
}
