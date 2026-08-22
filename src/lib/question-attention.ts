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
 * 総数）で、こちらは丸を点ける合図にだけ使う。詳細は`computeQuestionAttention`。
 */
export function countUnconfirmedQuestions(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
): number {
  return issues.filter((issue) => resolveQuestionState(issue) === "unconfirmed").length;
}

/** 「質問」の行に出す材料（#2070） */
export type QuestionAttention = {
  /** 一覧に並ぶ件数（＝開いている質問Issueの総数）。行に出す数字はこちら */
  total: number;
  /** 未確認（回答が届いていて未読）の件数。オレンジの丸を点ける判定に使う */
  unconfirmed: number;
};

/**
 * 「質問」の行の数字と強調を1か所で求める（#2070）。**左メニュー（`sidebar-nav.tsx`）と
 * スマホのホーム（`mobile-home-screen.tsx`）が同じ値を使う。**
 *
 * **数字は一覧に並ぶ件数にする。** #1910で未確認の件数へ差し替えていたが、読み終えた質問しか
 * 残っていないときに、質問が何件も開いたままでも`0`と出て、タップした先の一覧ヘッダー
 * （`5件・未確認1件`）と食い違っていた。メニューの他の行はどれも「押した先に並ぶ件数」を
 * 出しているため、質問だけ別の数を出すと`0`が「質問は無い」と読めてしまう。
 *
 * **「いま読める回答がある」という#1910の合図はオレンジの丸として残す。** 丸が点いている行は
 * 上から順に手を動かせば消える、という読み方は変わらない。丸の中の数字は総数になるので、
 * 内訳はツールチップ（呼び出し側）と一覧ヘッダー（`formatQuestionListCount`）で読む。
 *
 * **「ユーザーの作業待ち」（`computeManualStepAttention`）は`actionable`のままにする。**
 * あちらの前提待ちは「まだ実行できない」もので在庫に数えると手を動かせる数が読めなくなるが、
 * 質問の確認済みは「読んだがまだcloseしていない」＝人が片付ける余地が残っているものなので、
 * 総数に含めるほうが実態に合う。
 *
 * @param issues 「質問」ビューで絞り込み済みのIssue（`filterIssuesByView(..., "question")`）
 */
export function computeQuestionAttention(
  issues: Pick<Issue, "title" | "qaAnswerPendingAt" | "hasUnreadComments">[],
): QuestionAttention {
  return { total: issues.length, unconfirmed: countUnconfirmedQuestions(issues) };
}

/**
 * 「質問」の行のツールチップ（#2070）。**数字（総数）と丸（未確認）で意味が違うため、
 * 行のラベルだけでは何を数えているのか読めない。**
 */
export function formatQuestionNavTitle(attention: QuestionAttention): string {
  if (attention.unconfirmed === 0) return `開いている質問が${attention.total}件あります`;
  return `開いている質問が${attention.total}件（うち回答が届いていてまだ開いていないものが${attention.unconfirmed}件）あります`;
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
