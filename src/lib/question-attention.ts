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
 * 未確認（回答が届いていて未読）の質問Issueの件数。**左メニュー・スマホのホームでオレンジの
 * 丸を点けるかどうかの判定**（#1796・#1910）と、一覧ヘッダーの内訳に使う。
 *
 * **メニューに出す数字そのものではない**（#2070）。数字は一覧に並ぶ件数（＝開いている質問の
 * 総数）で、こちらは丸を点ける合図にだけ使う。詳細は`formatQuestionNavTitle`。
 */
export function countUnconfirmedQuestions(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
): number {
  return issues.filter((issue) => resolveQuestionState(issue) === "unconfirmed").length;
}

/**
 * 一覧の行に「回答待ち」を出すか（#2309）。
 *
 * **`resolveQuestionState`の`waiting`と違い、質問Issue（タイトルの接頭辞）に限らない。**
 * 「質問する」ボタンはIssue詳細のコメント欄にもあり、通常のIssueへ投げた質問も同じように
 * `qaAnswerPendingAt`が立つ。あちらの判定をそのまま使うと、投げた直後の行に何も出ないまま
 * 数分待つことになる。
 *
 * **未確認（回答が届いていて未読）の判定はこちらへ移していない。** あちらは「質問」ビューの
 * 在庫を数えるためのもので、母集団を広げると左メニューの数字と一覧の行数が食い違う。
 */
export function isQaAnswerWaiting(issue: Pick<Issue, "qaAnswerPendingAt">): boolean {
  return issue.qaAnswerPendingAt !== null;
}

/**
 * 回答待ち（質問を投げて、まだ回答が届いていない）の質問Issueの件数（#2309）。
 * **左メニュー・スマホのホームでスピナーを回すかどうかの判定**と、吹き出しの内訳に使う。
 *
 * **数えるのは質問Issueだけ**（`isQaAnswerWaiting`ではなく`resolveQuestionState`を使う）。
 * この件数が付くのは「質問」の行で、押した先に並ぶのは質問Issueに限られる。通常のIssueへ
 * 投げた質問まで数えると、スピナーを追って開いた先にその質問が居ない。
 */
export function countWaitingQuestions(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
): number {
  return issues.filter((issue) => resolveQuestionState(issue) === "waiting").length;
}

/**
 * 「質問」の行のツールチップ（#2070）。**行の数字（一覧に並ぶ件数）と丸（未確認があるという
 * 合図）で意味が違うため、行のラベル（「質問」）だけでは何を数えているのか読めない。**
 *
 * **数字そのものは数え直さず、`computeNavCountsForFilters`が数えた件数を`total`へ渡す。**
 * 画面側で数え直すと、同じ行の数字とツールチップが別の数え方になる
 * （`docs/code-map.md`「数え方の差し替えは`computeNavCountsForFilters`で行う」）。
 *
 * **未確認は「質問」の数字を差し替えるためのものではない**（#1910ではそうしていたが、
 * 読み終えた質問しか無いときに、質問が何件も開いたままでも`0`と出て「質問は無い」と
 * 読めていた）。使うのはオレンジの丸を点ける判定と、この吹き出しの内訳だけ。
 * **「ユーザーの作業待ち」（`actionable`）と揃えないのは、あちらの前提待ちが
 * 「まだできない」ものなのに対し、質問の確認済みは「読んだがまだcloseしていない」＝
 * 人が片付ける余地が残っているもので、在庫として数えるほうが実態に合うため。**
 *
 * **回答待ちの件数もここへ入れる**（#2309）。行に回るアイコンを足したが、アイコンだけでは
 * 何件待っているのかを読めない。内訳は「回答待ち」→「未確認」の順に並べる——待っている方が
 * 新しく、読める方が後から増えるため。
 *
 * @param total 一覧に並ぶ件数（＝`navCounts["question"]`）
 * @param unconfirmed 未確認の件数（`countUnconfirmedQuestions`）
 * @param waiting 回答待ちの件数（`countWaitingQuestions`）
 */
export function formatQuestionNavTitle(
  total: number,
  unconfirmed: number,
  waiting = 0,
): string {
  const parts: string[] = [];
  if (waiting > 0) parts.push(`回答待ちが${waiting}件`);
  if (unconfirmed > 0) parts.push(`回答が届いていてまだ開いていないものが${unconfirmed}件`);
  if (parts.length === 0) return `開いている質問が${total}件あります`;
  return `開いている質問が${total}件（うち${parts.join("・")}）あります`;
}

/**
 * 「質問」ビューの一覧ヘッダーに出す件数表記（#1796）。未確認が1件も無ければnullを返し、
 * 呼び出し側は従来どおりの「N件」に落とす。
 *
 * **メニューの数字と一覧の行数は#2070で揃えたが、内訳はここに残す。** メニューではオレンジの
 * 丸の有無でしか未確認を表せず、何件読めるのかはここでしか読めない。
 * `formatManualStepListCount`（#1763）と同じ役割・同じ区切り。
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
