import type { ReleaseMergePendingCounts } from "@/lib/release-merge-pending";

export type AppBadgeCountInput = {
  /** 「ホーム」タブの確認待ち件数（確認待ちIssue＋Issueに紐づかないマージ待ちPR） */
  checkUserCount: number;
  /** 上の件数へ足したPRのid（`<owner>/<repo>#<番号>`）。`pullRequestsCountedAsCheckUser`の結果 */
  checkUserPullRequestIds: readonly string[];
  /** 「ブランチ」タブの反映待ち。未取得はnull */
  mergePending: ReleaseMergePendingCounts | null;
  /** 「リリース」タブの未確認件数。未取得はnull */
  releaseUncheckedCount: number | null;
};

/**
 * PWAのアプリアイコンのバッジに出す件数（#3433）。フッターの「ホーム」「ブランチ」「リリース」
 * の3つのバッジの合計。
 *
 * リリースPR（develop→main）は「ホーム」の確認待ちにも「ブランチ」のマージ待ちにも入るので、
 * 両方に現れるPRは1件として数える（ブランチ側から引く）。
 */
export function computeAppBadgeCount({
  checkUserCount,
  checkUserPullRequestIds,
  mergePending,
  releaseUncheckedCount,
}: AppBadgeCountInput): number {
  const homePullRequestIds = new Set(checkUserPullRequestIds);
  const branchOnly = (mergePending?.pullRequestIds ?? []).filter((id) => !homePullRequestIds.has(id));

  return checkUserCount + branchOnly.length + (releaseUncheckedCount ?? 0);
}
