import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * リポジトリへの質問機能（#691・#1641）は#5047で廃止し、聞きたいことはリモートセッションで聞く形にした。
 * **このファイルに残っているのは、過去に作られた質問Issue・質問コメント・回答コメントを読むための判定だけ。**
 * 質問を新しく投稿する経路（本文の組み立て・送信）はもう無い。
 */

/** 質問コメントの目印 */
export const QUESTION_COMMENT_MARKER = "<!-- issue-deck-question -->";
/** 過去に投稿されたActions向け質問を読むためだけに残す。 */
export const ASK_CLAUDE_COMMENT_PREFIX = "@claude 質問: ";

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
 * 指定したコメントが、「質問する」ボタン経由の質問コメントかどうかを判定する。
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
 *
 * **回答できなかったことの通知（フォールバック通知）でも回答待ちを終える**（#1766）。質問への
 * 回答は、行き詰まりやエラーで回答コメントに到達できないまま終わることがある。回答コメントだけを
 * 終わりの合図にすると、その質問は画面上いつまでも「Claudeの回答待ち」のままになり、質問Issueの
 * ワンボタンクローズ（`canCloseAskRepoQuestion`）も出てこない。
 */
export function isQaAnswerPending(comments: Pick<IssueComment, "body">[]): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (isQaAnswerComment(comment)) return false;
    if (isFallbackNoticeComment(comment)) return false;
    if (isAskClaudeQuestionComment(comment)) return true;
  }
  return false;
}

/**
 * 複数リポジトリ横断の質問（#1454）であることの目印。**回答するのはサブPCの質問セッションで、
 * GitHub Actionsではない。**
 *
 * `QUESTION_COMMENT_MARKER`と併せて付ける（質問であることの識別はあちらが持ち、こちらは
 * 「どの経路が答えるか」を画面へ出すためのもの）。本文に`@claude`を含めないため、
 * `claude-issue-dispatch.yml`のトリガー条件には掛からない。
 */
export const CROSS_REPO_QUESTION_MARKER = "<!-- issue-deck-cross-repo-question -->";

/** 指定したコメントが横断質問（#1454）かどうかを判定する */
export function isCrossRepoQuestionComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(CROSS_REPO_QUESTION_MARKER);
}

/**
 * 横断質問（#1454）として立てられたIssueかどうかを、コメント列から判定する。
 *
 * 記録先のリポジトリ名（`question`）では判定しない。**`resolveCrossRepoQuestionRepository`が
 * フォールバックを持つため、`question`リポジトリが無い環境では別のリポジトリへ立つ。**
 * 横断質問ダイアログ（#4991で廃止）が投稿していた`CROSS_REPO_QUESTION_MARKER`付きのコメントだけが
 * 恒久的な目印になる。過去に立てたIssueの判定のために残している。
 */
export function isCrossRepoQuestionIssue(comments: Pick<IssueComment, "body">[]): boolean {
  return comments.some(isCrossRepoQuestionComment);
}

/**
 * 質問フローがIssueタイトルに付与する接頭辞。
 * このタイトルを持つIssueかどうかで、質問フロー由来のIssueかを判定する（#885）。
 */
export const ASK_REPO_QUESTION_TITLE_PREFIX = "[質問] ";

/**
 * 上記接頭辞の**旧形式**（#1514で`[質問] `へ変更する前のもの）。
 *
 * **判定では引き続き受け付ける。** 既にGitHub上に作られている質問Issueのタイトルは
 * この形のままで、片方しか見ないと既存分が「質問」ビューにも詳細画面のワンボタンクローズにも
 * 出てこなくなる。タイトルの一括リネームは行わない（判定が両対応なら不要なうえ、GitHub側への
 * 一括書き込みになる）。受け入れを消せるのは、旧形式の質問Issueが全てcloseされたあと。
 *
 * なおコメント側のトリガー接頭辞`ASK_CLAUDE_COMMENT_PREFIX`（`@claude 質問: `）は別物で、
 * 他リポジトリのワークフローの起動条件と対になっているため変更していない。
 */
export const ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY = "質問: ";

/** 「リポジトリに質問する」ダイアログ経由で作成されたIssueかどうかを判定する */
export function isAskRepoQuestionIssue(issue: Pick<Issue, "title">): boolean {
  return (
    issue.title.startsWith(ASK_REPO_QUESTION_TITLE_PREFIX) ||
    issue.title.startsWith(ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY)
  );
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

/** コメント入力欄の下の操作列で、主ボタン（塗りつぶし）を持つ操作（#2345） */
export type ComposerPrimaryAction = "comment" | "close";

/**
 * コメント入力欄の下の操作列で、どれを主ボタンにするかを決める（#2345）。
 *
 * 回答を読み終えた過去の質問Issueで入力欄が空なら、用事はクローズなので「回答を確認して
 * クローズ」を主にする。書きかけがあるか、質問Issueでなければ「コメント」が主。
 * 質問の送信は#5047で廃止したため、`question`を主にすることはもう無い。
 *
 * `Ctrl`+`Enter`の宛先は常に投稿操作の`comment`。**クローズをキーボードショートカットに
 * 割り当ててはいけない。**
 */
export function resolveComposerPrimaryAction(
  issue: Pick<Issue, "state" | "title">,
  comments: Pick<IssueComment, "body">[],
  hasDraft: boolean,
): ComposerPrimaryAction {
  return !hasDraft && canCloseAskRepoQuestion(issue, comments) ? "close" : "comment";
}
