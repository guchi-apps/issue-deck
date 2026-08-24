import { findLinkedPullRequest } from "@/lib/check-user-notification";
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
import {
  findPlanRequestForIssue,
  type SessionPlanRequestView,
} from "@/lib/dispatch/session-plan-request";
import {
  findQuestionRequestForIssue,
  type SessionQuestionRequestView,
} from "@/lib/dispatch/session-question-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { isApprovalPending } from "@/lib/github/approval-labels";
import { isMergeWaitingForChecks } from "@/lib/pull-request-list";
import { isSessionActivelyWorking } from "@/lib/workflow-badge-activity";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 確認待ち（`00.check-user`）のうち、**まだエージェントが動いていて人が押せるものが無い**
 * ものを見分ける（#2174）。
 *
 * `00.check-user`は「人の対応が要る」ことしか表さず、付けた側はエージェントが止まるのを
 * 待たない。develop向けPRを作った直後は`01.check-merge`が付いた状態でCIとレビュー
 * （`claude-review-develop.yml`の自動マージ判定）が走っており、押しても弾かれる。サブPCの
 * セッションが作業を続けている間も同じで、**開いても押せる操作が無いのにオレンジの丸が点く**。
 * 数え続けると、あの数字が「手を動かせば減る数」として読めなくなる。
 *
 * **PR側は#2081で同じ扱いを先に入れている**（`pullRequestsAwaitingUserMerge`が
 * `isMergeWaitingForChecks`なPRを一覧と件数から外す）。ここはそれをIssue側へ広げたもので、
 * 判定材料も同じものを使い回す——新しいAPI・ポーリングは足さない。
 *
 * | 材料 | 実行中とみなす条件 |
 * |---|---|
 * | 計画・質問の待ち（#2238） | `WAITING`が1件でもあれば**実行中ではない**（他の材料より優先） |
 * | 対応PR（`linkedIssueNumber`） | `isMergeWaitingForChecks`（CI実行中・自動マージ判定中） |
 * | サブPCのセッション | `isSessionActivelyWorking`（`ALIVE`かつ入力待ち・未開始でなく、報告が新しい） |
 *
 * **計画の承認待ち・質問の回答待ちを最初に見るのは、セッションの様子（`activity`）では
 * それが分からないため**（#2238）。`ExitPlanMode`・`AskUserQuestion`のフックは待ちを作った後
 * そのまま画面の返事をポーリングして止まり、**その間`activity`を報告しない**
 * （`scripts/session-notify.sh`）。pollerは1巡ごとに`lastReportedAt`だけを更新するので
 * 報告の古さでも落ちず、直前の`WORKING`／`RESPONDED`が残ったまま
 * `isSessionActivelyWorking`が真になる。実際に「計画を承認」「質問に答える」が並んでいる
 * のに件数が`0`（一覧のヘッダーは`0件・実行中2件`）になっていた。
 *
 * **待ちは`activity`より確かな材料**なので、他の2つより先に見る。画面に押せるボタンが
 * 出ている根拠そのもの（`issue-list.tsx`が同じ`WAITING`でボタンを出す）で、答えるか
 * 期限が切れるまで`WAITING`のままになる。
 *
 * **GitHub Actionsの実行そのものは見ていない。** 一覧のバッジが使う
 * `useIssuesWorkflowRunning`は確認待ちのIssueを最初からポーリング対象から外しており
 * （GitHub APIを空振りで消費しないため）、確認待ちの間は材料が無い。無人実行で確認待ちに
 * なる場面はPRを伴うもの（`01.check-merge`）が大半で、そちらは上のPR側の材料で拾える。
 *
 * **`00.check-user`が付いていないIssueは常にfalse。** 実行中かどうかを表す一般の判定では
 * なく、「確認待ちとして数えるか」だけを決める。
 */

/** 判定に使う材料。どれも画面が既に持っているものだけ */
export type CheckUserAgentContext = {
  /** 横断のPR一覧（`crossRepositoryPullRequests`）。対応PRの引き当てに使う */
  pullRequests: readonly PullRequestSummary[];
  /** サブPCのセッション（`useDispatchState`の`sessions`）。未取得なら空配列でよい */
  sessions: readonly DispatchSessionView[];
  /**
   * 計画への返事待ち（`useDispatchState`の`planRequests`）。**未取得なら空配列でよい**
   * ——判定できないことを理由に、従来どおりの「実行中」判定を止めない（#2238）
   */
  planRequests?: readonly SessionPlanRequestView[];
  /** 質問への回答待ち（`useDispatchState`の`questionRequests`）。同上 */
  questionRequests?: readonly SessionQuestionRequestView[];
  /** 現在時刻(epoch ms)。マウント前などで未取得(null)のときは報告の古さを見ない */
  now: number | null;
};

/**
 * そのIssueが、画面から答えられる待ち（計画の承認・質問の回答）を抱えているか（#2238）。
 *
 * **判定は一覧の行がボタンを出す条件と同じ**（`issue-list.tsx`の`planPendingIssueIds`・
 * `questionPendingIssueIds`）。別々に書くと、行に「計画を承認」が出ているのに件数からは
 * 外れている、という食い違いが戻る。
 */
function hasPendingSessionRequest(
  issue: Pick<Issue, "repositoryFullName" | "number">,
  context: CheckUserAgentContext,
): boolean {
  // 現在時刻はどちらの引き当てでも「押した直後の結果表示」を消すためだけに使う。
  // 未取得(null)なら既定（実時刻）に任せる——`WAITING`は時刻によらず引けるため影響しない
  const now = context.now === null ? undefined : new Date(context.now);
  const plan = findPlanRequestForIssue(
    context.planRequests ?? [],
    issue.repositoryFullName,
    issue.number,
    now,
  );
  if (plan?.status === "WAITING") return true;
  const question = findQuestionRequestForIssue(
    context.questionRequests ?? [],
    issue.repositoryFullName,
    issue.number,
    now,
  );
  return question?.status === "WAITING";
}

/** そのIssueの確認待ちが、まだエージェントの実行を待っている状態か（#2174・#2238） */
export function isCheckUserWaitingForAgent(
  issue: Pick<Issue, "labels" | "repositoryFullName" | "number">,
  context: CheckUserAgentContext,
): boolean {
  if (!isApprovalPending(issue.labels)) return false;
  // 画面から答えられる待ちがあるなら、セッションの様子によらず「人の番」（#2238）
  if (hasPendingSessionRequest(issue, context)) return false;
  const pullRequest = findLinkedPullRequest(context.pullRequests, issue);
  if (pullRequest !== null && isMergeWaitingForChecks(pullRequest)) return true;
  const session = findSessionForIssue(context.sessions, issue.repositoryFullName, issue.number);
  return isSessionActivelyWorking(session, context.now);
}

/**
 * 実行中とみなす確認待ちIssueのid集合（#2174）。
 *
 * **左メニューの件数・一覧のヘッダー・ベルが同じ集合を読む。** 判定を呼び出し側ごとに書くと、
 * 片方だけ直された時点で「メニューからは消えているのにベルには出ている」状態になる。
 */
export function selectCheckUserRunningIssueIds(
  issues: readonly Issue[],
  context: CheckUserAgentContext,
): Set<string> {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (isCheckUserWaitingForAgent(issue, context)) ids.add(issue.id);
  }
  return ids;
}

/**
 * Issue一覧のヘッダーに出す件数（#2174）。
 *
 * 左メニューが「いま押せる件数」を出すようになったため、ヘッダーが行数のままだとメニューの数と
 * 食い違う。**メニューと同じ数を先に出し、その差である実行中を添える**——手作業待ちの
 * `formatManualStepListCount`（#1763）・質問の`formatQuestionListCount`（#1796）と同じ区切り。
 *
 * @returns 実行中が1件も無ければnull（呼び出し側は今までどおりの「N件」を出す）
 */
export function formatCheckUserListCount(
  listedCount: number,
  runningCount: number,
): string | null {
  if (runningCount <= 0) return null;
  return `${Math.max(listedCount - runningCount, 0)}件・実行中${runningCount}件`;
}
