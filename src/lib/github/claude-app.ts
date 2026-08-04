import type { Issue } from "@/types/issue";

/**
 * Claudeアプリ（claude.ai/code）で新規セッションを開始する画面のベースURL。
 * `branch=develop`を付与することで、developブランチを起点にセッションが開始されることを確認済み（#360）。
 */
const CLAUDE_APP_NEW_SESSION_URL = "https://claude.ai/code/new";

/**
 * GitHub Actions上のClaude（claude-issue-dispatch.yml）には実行時間・権限等の制限があるため、
 * Claudeアプリ上で同じIssueの実装を進められるよう、対象Issueを特定できるプロンプトを組み立てる。
 */
export function buildClaudeAppPrompt(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  return `${issue.repositoryFullName} の Issue #${issue.number}「${issue.title}」を実装してください。\n${issue.htmlUrl}`;
}

/** Issueを指定してClaudeアプリのセッション開始画面（プロンプト入力済み）に遷移するURLを組み立てる */
export function buildClaudeAppUrl(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  const params = new URLSearchParams({
    branch: "develop",
    q: buildClaudeAppPrompt(issue),
  });
  return `${CLAUDE_APP_NEW_SESSION_URL}?${params.toString()}`;
}
