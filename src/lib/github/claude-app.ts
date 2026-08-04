import type { Issue } from "@/types/issue";

/**
 * Claudeアプリ（claude.ai/code）で新規セッションを開始する画面のベースURL。
 * `branch=develop`を付与することで、developブランチを起点にセッションが開始されることを確認済み（#360）。
 */
const CLAUDE_APP_NEW_SESSION_URL = "https://claude.ai/code/new";

/**
 * GitHub Actions上のClaude（claude-issue-dispatch.yml）には実行時間・権限等の制限があるため、
 * Claudeアプリ上で同じIssueの続きに取り組めるよう、対象Issueを特定できるプロンプトを組み立てる。
 * 実装の続きだけでなく質問・相談で開くケースもあるため、「実装してください」のような特定の
 * アクションは指示せず、対象Issueとの関連付けのみを記載する（#415）。
 */
export function buildClaudeAppPrompt(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  return `${issue.repositoryFullName} の Issue #${issue.number}「${issue.title}」に関連するセッションです。\n${issue.htmlUrl}`;
}

/**
 * Issueを指定してClaudeアプリのセッション開始画面（プロンプト入力済み）に遷移するURLを組み立てる。
 *
 * `URLSearchParams`はスペースを`+`にエンコードする（application/x-www-form-urlencoded）が、
 * Claudeアプリ側はクエリパラメータの`+`をスペースへ変換せずそのまま表示してしまうため（#394）、
 * スペースを`%20`にエンコードする`encodeURIComponent`でクエリ文字列を組み立てる。
 */
export function buildClaudeAppUrl(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  const params = { branch: "develop", q: buildClaudeAppPrompt(issue) };
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${CLAUDE_APP_NEW_SESSION_URL}?${query}`;
}
