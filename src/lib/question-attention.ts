import { isAskRepoQuestionIssue } from "@/lib/github/ask-claude";
import type { Issue } from "@/types/issue";

/**
 * 過去の質問Issue（`isAskRepoQuestionIssue`）1件の状態（#1796）。質問機能は#5047で廃止したが、
 * すでにある質問Issueは一覧の行に状態を出し続ける。左メニューの「質問」と件数・合図は廃止した。
 *
 * - `waiting` … 質問を投げたが、まだ回答コメントが来ていない（`qaAnswerPendingAt`）
 * - `unconfirmed` … 回答は届いているが、まだ本人が開いていない（未読コメントあり）
 * - `confirmed` … 読み終わっている
 */
export type QuestionState = "waiting" | "unconfirmed" | "confirmed";

/**
 * 質問Issueの状態を求める。質問Issueでなければnull（判定材料はすでに取得済みの
 * `Issue`だけで、追加のGitHub API消費もDBの列も無い）。
 *
 * **未読の判定は既存の未読管理（`hasUnreadComments`＝一覧の青いドットと同じ）に乗せる。**
 * 質問だけ別の基準（回答コメントを開いたか等）を作ると、同じ行の中でドットとラベルが
 * 食い違う。開いた時点で既読になる（`POST /api/issues/read`）挙動もドットと共通。
 */
export function resolveQuestionState(
  issue: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">,
): QuestionState | null {
  if (!isAskRepoQuestionIssue(issue)) return null;
  if (issue.qaAnswerPendingAt) return "waiting";
  return issue.hasUnreadComments ? "unconfirmed" : "confirmed";
}

/**
 * 一覧の行に「回答待ち」を出すか（#2309）。
 *
 * **`resolveQuestionState`の`waiting`と違い、質問Issue（タイトルの接頭辞）に限らない。**
 * 廃止前の「質問する」ボタンはIssue詳細のコメント欄にもあり、通常のIssueへ投げた質問も同じように
 * `qaAnswerPendingAt`が立っていたため。
 */
export function isQaAnswerWaiting(issue: Pick<Issue, "qaAnswerPendingAt">): boolean {
  return issue.qaAnswerPendingAt !== null;
}
