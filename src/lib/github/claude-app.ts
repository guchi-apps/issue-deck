import type { Issue, IssueComment } from "@/types/issue";

/**
 * Claudeアプリ（claude.ai/code）で新規セッションを開始する画面のベースURL。
 * `branch`にIssue固有のブランチ名（`issue-<番号>`）を付与することで、無人実行と同じブランチを
 * 起点にセッションが開始される（#499）。
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
  const params = { branch: `issue-${issue.number}`, q: buildClaudeAppPrompt(issue) };
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${CLAUDE_APP_NEW_SESSION_URL}?${query}`;
}

/**
 * 「Claudeアプリで開く」ボタン押下時に投稿する引き継ぎ記録コメントの末尾に付与するマーカー
 * （claude-issue-dispatch.ymlやissue-labels.ymlの状態管理と区別するための検出用）。
 */
export const CLAUDE_APP_HANDOFF_COMMENT_MARKER = "<!-- issue-deck-claude-app-handoff -->";

/**
 * 「Claudeアプリで開く」ボタン押下時にIssueへ投稿する引き継ぎ記録コメントの本文を組み立てる。
 *
 * `@claude`から書き始めるとclaude-issue-dispatch.ymlの`startsWith("@claude")`トリガーを
 * 誤爆させてしまう（無人実行を再起動してしまう）ため、先頭には付けない。
 */
export function buildClaudeAppHandoffCommentBody(): string {
  return `🤖 Claudeアプリでの作業に切り替えます。\n\n${CLAUDE_APP_HANDOFF_COMMENT_MARKER}`;
}

/** 指定したコメントが、上記の引き継ぎ記録コメントかどうかを判定する */
export function isClaudeAppHandoffComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(CLAUDE_APP_HANDOFF_COMMENT_MARKER);
}
