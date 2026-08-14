import type { Issue, IssueComment } from "@/types/issue";

/**
 * 質問コメントに付けるマーカー（#1294）。**「質問である」ことの唯一の目印**で、回答側の
 * `QA_ANSWER_MARKER`と対になる。
 *
 * 従来はActionsの起動トリガーそのもの（`@claude 質問: `プレフィックス）で質問かどうかを
 * 判定していたが、それだと**同じコメントをサブPCにも処理させた時点で必ず二重に回答する**
 * （#1290）。「Issueに残す質問コメント」と「Actionsを起こすトリガー」を別の軸にするため、
 * 識別はこのマーカーへ移し、トリガーは本文の先頭に`@claude`を置くかどうかで決める。
 */
export const QUESTION_COMMENT_MARKER = "<!-- issue-deck-question -->";

/**
 * 質問コメントのうち、**GitHub Actions（claude-issue-dispatch.yml）を起こす形**の先頭に置く
 * プレフィックス。reusable-issue-dispatch.ymlのmode=ask判定に使う。
 *
 * **この文字列を変えたり外したりしてはいけない。** 他リポジトリは
 * reusable-issue-dispatch.ymlをタグ固定（`@workflows/vX`）で参照しており、古いタグの
 * `IS_ASK`はこのプレフィックスしか見ない。issue-deckが投稿する本文の形を変えると、
 * 古いタグのリポジトリでは質問がmode=askに落ちず**実装モードとして走る**。
 */
export const ASK_CLAUDE_COMMENT_PREFIX = "@claude 質問: ";

/**
 * 質問コメントの投稿先（＝誰に答えさせるか）。
 *
 * - `actions` … 従来どおりGitHub Actionsに答えさせる（現状の唯一の経路）
 * - `none` … どこも起こさない。**サブPC側で実行する場合に使う**（#1294のStep 3で開ける）。
 *   本文に`@claude`を含めないため、Actionsのトリガー条件
 *   （`startsWith(github.event.comment.body, '@claude')`）に掛からない
 */
export type QuestionCommentTrigger = "actions" | "none";

/**
 * 質問コメントの本文を組み立てる。**識別のマーカーは常に付き、トリガーの有無だけが変わる。**
 */
export function askClaudeCommentBody(
  question: string,
  options?: { trigger?: QuestionCommentTrigger },
): string {
  const trigger = options?.trigger ?? "actions";
  const prefix = trigger === "actions" ? ASK_CLAUDE_COMMENT_PREFIX : "";
  return `${prefix}${question.trim()}\n\n${QUESTION_COMMENT_MARKER}`;
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

/**
 * 指定したコメントが、「Claudeに質問する」ダイアログ経由の質問コメントかどうかを判定する。
 *
 * **新旧どちらの形式も質問として認識する**（#1294）。マーカーを持たない
 * `@claude 質問: `形式のコメントが既にIssueへ積まれており、そちらを質問として扱わなくなると、
 * 回答待ちの表示とワンボタンクローズ（`canCloseAskRepoQuestion`）の挙動が既存Issueで変わる。
 */
export function isAskClaudeQuestionComment(comment: Pick<IssueComment, "body">): boolean {
  return (
    comment.body.includes(QUESTION_COMMENT_MARKER) ||
    comment.body.startsWith(ASK_CLAUDE_COMMENT_PREFIX)
  );
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
