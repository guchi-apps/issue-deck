import type { Issue, IssueComment } from "@/types/issue";

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

/**
 * claude-issue-dispatch.ymlが質問への回答コメントを投稿する際に末尾へ付与するマーカー
 * （mode=ask、mode=plan・mode=additionalで「単なる質問・確認」と判定した場合の回答が対象）。
 */
export const QA_ANSWER_MARKER = "<!-- issue-deck-qa-answer -->";

/** 指定したコメントが、上記の質問への回答コメントかどうかを判定する */
export function isQaAnswerComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(QA_ANSWER_MARKER);
}

/** 指定したコメントが、「Claudeに質問する」ダイアログ経由の質問コメントかどうかを判定する */
export function isAskClaudeQuestionComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.startsWith(ASK_CLAUDE_COMMENT_PREFIX);
}

/**
 * コメント配列（時系列順）を末尾から走査し、直近の質問コメント（isAskClaudeQuestionComment）が
 * 回答コメント（isQaAnswerComment）より後に投稿されている、すなわち「回答待ち」かどうかを判定する。
 */
export function isQaAnswerPending(comments: Pick<IssueComment, "body">[]): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (isQaAnswerComment(comment)) return false;
    if (isAskClaudeQuestionComment(comment)) return true;
  }
  return false;
}

/**
 * 「リポジトリに質問する」ダイアログ（AskRepoQuestionDialog）がIssueタイトルに付与する接頭辞。
 * このタイトルを持つIssueかどうかで、質問フロー由来のIssueかを判定する（#885）。
 */
export const ASK_REPO_QUESTION_TITLE_PREFIX = "質問: ";

/** 「リポジトリに質問する」ダイアログ経由で作成されたIssueかどうかを判定する */
export function isAskRepoQuestionIssue(issue: Pick<Issue, "title">): boolean {
  return issue.title.startsWith(ASK_REPO_QUESTION_TITLE_PREFIX);
}

/**
 * 質問Issueをワンボタンでクローズできるようにするための表示条件。
 * open状態かつ質問Issueであり、かつ回答待ちではない（回答が来る前に誤ってクローズするのを防ぐ）
 * 場合のみtrueを返す。
 */
export function canCloseAskRepoQuestion(
  issue: Pick<Issue, "state" | "title">,
  comments: Pick<IssueComment, "body">[],
): boolean {
  return issue.state === "open" && isAskRepoQuestionIssue(issue) && !isQaAnswerPending(comments);
}
