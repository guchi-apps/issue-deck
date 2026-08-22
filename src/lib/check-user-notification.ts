import { checkUserReason, isApprovalPending } from "@/lib/github/approval-labels";
import { isMergeWaitingForChecks } from "@/lib/pull-request-list";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 「PRをマージしてください」という確認待ちの通知を、対応PRのチェックが終わるまで保留する（#1709）。
 *
 * `00.check-user`が付いた瞬間にトースト（`check-user-toast-viewport.tsx`）とベル（`notifications.ts`）が
 * 「PRのマージ」と知らせるが、**ラベルを付ける側はCIの完了を待たないことがある**。
 *
 * - 実装エージェントがPR作成の直後に自分で`00.check-user`＋`01.check-merge`を付ける
 *   （本来マージ可否を決めるのは`claude-review-develop.yml`の`auto-merge`ジョブで、こちらは
 *   `wait-for-ci`でCIの完了を待つ）
 * - `reusable-issue-labels.yml`の`develop-pr-opened`が、レビュー経路を持たないリポジトリの保険として
 *   PRのopen時点で付ける（#1470）
 *
 * どちらでも、知らせを受けて開いた時点ではPRが「CI実行中」でマージできない。#1709で実際に起きた例では、
 * 10分後に自動マージされてラベルごと消えたため、**通知そのものが不要だった**。
 *
 * そこで通知の側で「対応PRのチェックが確定しているか」を見て、確定するまで出さずに持つ。判定材料は
 * PR一覧（`/api/pull-requests`）が既に持っている`ciState`で、新しいGitHub APIの消費は増えない。
 * **持ち続けて消えることが無いよう、判断できないものは出す側へ倒す**（下の各条件のコメントを参照）。
 */

/** 保留の上限。ここを過ぎたら判定できていなくても通知する（通知が消えるより遅れる方が軽い） */
export const CHECK_USER_TOAST_MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * Issueに紐づくopenなPRを1件返す。`linkedIssueNumber`（＝`issue-<番号>`ブランチ名から確度高く
 * 引けたもの）だけを見るので、本文の`#番号`が単に言及されているだけのPRは拾わない。
 */
export function findLinkedPullRequest(
  pullRequests: readonly PullRequestSummary[],
  issue: Pick<Issue, "repositoryFullName" | "number">,
): PullRequestSummary | null {
  return (
    pullRequests.find(
      (pullRequest) =>
        pullRequest.state === "open" &&
        pullRequest.repositoryFullName === issue.repositoryFullName &&
        pullRequest.linkedIssueNumber === issue.number,
    ) ?? null
  );
}

/**
 * その確認待ちが「ユーザーのマージ操作」を求めているか。
 *
 * 理由ラベル（`01.check-*`）が読めるなら`merge`だけを対象にする。計画の承認・質問への回答は
 * CIと関係なく人が動けるため、待たせると単に通知が遅れるだけになる。
 * **理由ラベルが配られていないリポジトリでは`null`になる**ので、そのときだけ従来どおり
 * 「対応PRがあるならマージ待ちだろう」という推測へ倒す（`requiresUserMerge`と同じ扱い）。
 */
export function isMergeCheckUser(issue: Pick<Issue, "labels">): boolean {
  if (!isApprovalPending(issue.labels)) return false;
  const reason = checkUserReason(issue.labels);
  return reason === "merge" || reason === null;
}

/**
 * 「PRのマージ」を求める確認待ちなのに、そのPRのチェックがまだ確定していないか。
 * ベルの見せ方（バッジ・トーン）とトーストの保留のどちらもこの判定を使う。
 */
export function isMergeAwaitingCi(
  issue: Pick<Issue, "labels" | "repositoryFullName" | "number">,
  pullRequests: readonly PullRequestSummary[],
): boolean {
  if (!isMergeCheckUser(issue)) return false;
  const pullRequest = findLinkedPullRequest(pullRequests, issue);
  return pullRequest !== null && pullRequest.ciState === "pending";
}

/** 保留中のトースト1件。表示に使うのは`id`と`issue`だけで、残りは保留を解く判定のための記録 */
export type PendingCheckUserToast = {
  /** 表示側のkey。ラベルの解除→再付与を別物として扱うため付与時刻を含める */
  id: string;
  issue: Issue;
  /**
   * 検知した時点のPR一覧の取得時刻（`usePullRequests`の`fetchedAt`）。
   *
   * PR一覧はダッシュボードを開いた時点の内容のままなので、作られたばかりのPRはまだ載っていない。
   * **この値が変わる（＝検知の後に一度取り直した）までは「対応PRが無い」と判断しない。**
   * 時刻の大小ではなく変化で見るのは、サーバーが刻む時刻とクライアントの時計を比べないため。
   */
  pullRequestsFetchedAt: string | null;
  /** 検知した時刻（epoch ms）。保留の上限を測る基準 */
  detectedAt: number;
};

export type CheckUserToastResolution = {
  /** 表示してよくなったもの。`issue`は最新のポーリング結果に差し替えてある */
  ready: PendingCheckUserToast[];
  /** 引き続き保留するもの */
  held: PendingCheckUserToast[];
};

export type ResolveCheckUserToastsInput = {
  /** 最新のIssue一覧。確認待ちが解けたかの確認と、理由ラベルの読み直しに使う */
  issues: Issue[];
  pullRequests: PullRequestSummary[];
  /** PR一覧の最終取得時刻（未取得はnull） */
  pullRequestsFetchedAt: string | null;
  /**
   * まだエージェントが動いている確認待ちIssueのid（#2174。`selectCheckUserRunningIssueIds`）。
   *
   * **集合は呼び出し側が作る。** 判定にはサブPCのセッションが要り、それを持っているのは画面
   * （`IssueDeckShell`）だけ。ここで取りに行くと、通知の組み立てがデータの取得を抱えることになる。
   */
  runningIssueIds?: ReadonlySet<string>;
  now: number;
};

/**
 * 保留中のトーストを「出す」「まだ持つ」「捨てる」に振り分ける。
 *
 * **捨てるのは確認待ちが解けたときだけ。** 早すぎる付与が自動マージや修正依頼で取り消された場合で、
 * ここまで来れば知らせる相手のいない通知なので出さずに終える（#1709で実際に起きた形）。
 */
export function resolveCheckUserToasts(
  pending: readonly PendingCheckUserToast[],
  input: ResolveCheckUserToastsInput,
): CheckUserToastResolution {
  const { issues, pullRequests, pullRequestsFetchedAt, runningIssueIds, now } = input;
  const issuesById = new Map(issues.map((issue) => [issue.id, issue] as const));
  const ready: PendingCheckUserToast[] = [];
  const held: PendingCheckUserToast[] = [];

  for (const item of pending) {
    const latest = issuesById.get(item.issue.id);
    // 確認待ちが解けた（ラベルが外れた）ものは通知しない
    if (latest && !isApprovalPending(latest.labels)) continue;

    const resolved = latest ? { ...item, issue: latest } : item;
    const { issue } = resolved;

    // 上限を過ぎたら、判定できていなくても出す
    if (now - item.detectedAt >= CHECK_USER_TOAST_MAX_HOLD_MS) {
      ready.push(resolved);
      continue;
    }
    // エージェントがまだ動いている間は、開いても押せる操作が無いので持つ（#2174）
    if (runningIssueIds?.has(issue.id)) {
      held.push(resolved);
      continue;
    }
    // マージ以外（計画の承認・質問への回答など）はCIと関係が無いので、そのまま出す
    if (!isMergeCheckUser(issue)) {
      ready.push(resolved);
      continue;
    }
    // 検知の後にPR一覧を取り直せていない間は判断できないので持つ
    if (pullRequestsFetchedAt === item.pullRequestsFetchedAt) {
      held.push(resolved);
      continue;
    }
    const pullRequest = findLinkedPullRequest(pullRequests, issue);
    // 対応PRが見つからない（対応PRを伴わない確認待ち・一覧に載らないPR）ものは判断材料が無いので出す
    if (pullRequest === null) {
      ready.push(resolved);
      continue;
    }
    // CIの実行中に加え、自動マージ可否の判定中も押せないので持つ（#2081と同じ`isMergeWaitingForChecks`）
    if (isMergeWaitingForChecks(pullRequest)) {
      held.push(resolved);
      continue;
    }
    ready.push(resolved);
  }

  return { ready, held };
}
