import type { Issue } from "@/types/issue";

/**
 * 「Claudeに質問する」ダイアログ押下時に投稿する定型コメントのプレフィックス
 * （claude-issue-dispatch.ymlのmode=ask判定に使う）。
 */
export const ASK_CLAUDE_COMMENT_PREFIX = "@claude 質問: ";

export function askClaudeCommentBody(question: string): string {
  return `${ASK_CLAUDE_COMMENT_PREFIX}${question.trim()}`;
}

/**
 * 「Claudeに質問する」ボタンは、実装状況によらずopenなissueであればいつでも
 * 表示する（コード変更を伴わない読み取り専用の質問のため、実装中・承認待ち等の
 * 状態を問わず利用できる）。
 */
export function canAskClaude(issue: Pick<Issue, "state">): boolean {
  return issue.state === "open";
}
