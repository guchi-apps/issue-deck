import { isAskRepoQuestionIssue } from "@/lib/github/ask-claude";
import type { Issue } from "@/types/issue";

/**
 * 質問Issue（`isAskRepoQuestionIssue`）1件の状態（#1796）。
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
 * **「回答待ち」は未確認に数えない。** 未確認は「回答が届いていて、まだ読んでいない」＝
 * *いま読める*ものを指す合図で、左メニューの件数（`countUnconfirmedQuestions`）と
 * オレンジの丸はそれが1件でもあるときだけ点く。質問を投げた直後から点けてしまうと、
 * 投げたこと自体を思い出すだけの合図になり、回答が返ってきたかどうかをそこから読めない。
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
 * 未確認（回答が届いていて未読）の質問Issueの件数。**左メニュー・スマホのホーム・スマホの
 * 一覧のビュー切替に出す「質問」の件数そのもの**で、オレンジの丸を点ける判定も兼ねる
 * （#1796・#1910）。数え直しは`issue-stats.ts`の`computeNavCountsForFilters`が1か所で行う。
 */
export function countUnconfirmedQuestions(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
): number {
  return issues.filter((issue) => resolveQuestionState(issue) === "unconfirmed").length;
}

/**
 * 「質問」ビューの一覧ヘッダーに出す件数表記（#1796）。未確認が1件も無ければnullを返し、
 * 呼び出し側は従来どおりの「N件」に落とす。
 *
 * **メニューの数字（＝未確認の件数。#1910）と一覧に並ぶ行数（＝確認済みも含めた総数）は
 * 意味が違うため、内訳をここで添える。** 添えないと、メニューの`1`と一覧の`3件`が
 * 食い違って見える。`formatManualStepListCount`（#1763）と同じ役割・同じ区切り。
 *
 * @param listedCount 一覧に並んでいる行数（固定表示ぶんを含む）
 */
export function formatQuestionListCount(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
  listedCount: number,
): string | null {
  const unconfirmed = countUnconfirmedQuestions(issues);
  if (unconfirmed === 0) return null;
  return `${listedCount}件・未確認${unconfirmed}件`;
}
