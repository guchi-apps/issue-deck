import { isApprovalPending } from "@/lib/github/approval-labels";
import { parsePullRequestId } from "@/lib/github-reference";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 用の済んだPush通知を、OSの通知センターから閉じてよいかの判定（#2407）。
 *
 * **Push通知は、届いたあとタップするまで端末に残り続ける。** `public/sw.js`が
 * `notification.close()`を呼ぶのは`notificationclick`だけで、ラベルが外れても、PRが
 * マージされても、ロック画面には「確認待ち」が並んだままになる。閉じられるのは通知を
 * 出したService Workerだけなので、画面（`use-push-notification-cleanup.ts`）が
 * `registration.getNotifications()`で表示中のものを引き、ここで済みかどうかを振り分ける。
 *
 * **判定は既存の関数へ委ねる。** 確認待ちは`isApprovalPending`（＝通知を送る側の
 * `check-user-push.ts`が見ているのと同じラベル）、本番マージ待ちは「そのPRがopenな
 * PR一覧にまだ載っているか」。ここで新しい基準を作ると、鳴らす条件と消す条件がずれて
 * 「まだ済んでいないのに消える」か「済んでいるのに残る」のどちらかになる。
 *
 * **判断できないものは残す側へ倒す。** 消しすぎると知らせが黙って消え、ユーザーには
 * 何も起きていないように見える（残っているぶんは開けば済んでいると分かる）。
 */

/** 確認待ち（`00.check-user`）の通知のタグ。`check-user-push.ts`が組み立てるもの */
const CHECK_USER_TAG_PREFIX = "check-user:";

/** 本番へのマージ待ちの通知のタグ。`release-merge-push.ts`が組み立てるもの */
const RELEASE_MERGE_TAG_PREFIX = "release-merge:";

export type SelectStalePushTagsInput = {
  /** いま端末に表示されている通知のタグ（`registration.getNotifications()`から） */
  tags: readonly string[];
  /**
   * 絞り込み前の全Issue（`GET /api/issues`はopen・closedの両方を返す）。
   * **未取得はnull**——空配列と区別しないと、読み込み前に全部消してしまう。
   */
  issues: readonly Issue[] | null;
  /** 取得済みのopenなPR一覧。未取得はnull */
  pullRequests: readonly PullRequestSummary[] | null;
  /**
   * PR一覧の取得に失敗したリポジトリ（`usePullRequests`の`failedRepositories`）。
   * ここのPRは「載っていない＝マージ済み」と読めないので触らない。
   */
  failedRepositories?: readonly string[];
};

/** その確認待ちが済んでいるか。Issueを引けなければ判断しない（null） */
function isCheckUserDone(issueId: string, issues: readonly Issue[]): boolean | null {
  const issue = issues.find((candidate) => candidate.id === issueId);
  if (!issue) return null;
  // closeされた時点で`00.check-user`は外れる（#2178）が、ラベルの反映を待たずに済みとする
  return issue.state !== "open" || !isApprovalPending(issue.labels);
}

/**
 * そのリリースPRのマージが済んでいるか。判断できなければnull。
 *
 * 母集団は`usePullRequests("open")`＝openなPRの全件なので、**載っていない＝閉じた
 * （マージされたか却下された）**と読める。CIが落ちたまま残っているPRは通知を残す——
 * 押す操作が修正へ変わるだけで、人が動かないと止まっているのは同じ（#2376）。
 */
function isReleaseMergeDone(
  pullRequestId: string,
  pullRequests: readonly PullRequestSummary[],
  failedRepositories: readonly string[],
): boolean | null {
  const parsed = parsePullRequestId(pullRequestId);
  if (!parsed) return null;
  if (failedRepositories.includes(parsed.repositoryFullName)) return null;
  return !pullRequests.some(
    (pullRequest) => pullRequest.id === pullRequestId && pullRequest.state === "open",
  );
}

/**
 * 表示中のタグのうち、閉じてよいものを返す。
 *
 * 知らないタグ（テスト通知の`test`など）は触らない。どこで作られたのか分からない通知を
 * 消すと、閉じた理由を後から追えなくなる。
 */
export function selectStalePushTags(input: SelectStalePushTagsInput): string[] {
  const { tags, issues, pullRequests, failedRepositories = [] } = input;

  return tags.filter((tag) => {
    if (tag.startsWith(CHECK_USER_TAG_PREFIX)) {
      if (issues === null) return false;
      return isCheckUserDone(tag.slice(CHECK_USER_TAG_PREFIX.length), issues) === true;
    }
    if (tag.startsWith(RELEASE_MERGE_TAG_PREFIX)) {
      if (pullRequests === null) return false;
      return (
        isReleaseMergeDone(
          tag.slice(RELEASE_MERGE_TAG_PREFIX.length),
          pullRequests,
          failedRepositories,
        ) === true
      );
    }
    return false;
  });
}
