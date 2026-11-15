import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";

/**
 * 人が動く番になっているリポジトリの件数（#5423）。メニューの「ブランチ」に出すバッジの数で、
 * ブランチ画面ヘッダーの「手が要るもの」と同じ基準（`release-pending-merges`の`needsUser`）。
 *
 * **未取得（`null`）と0件を区別して返す**（`countReleaseMergePending`と同じ作法）。
 */
export type ReleaseNeedsUserCounts = {
  total: number;
  /** 内訳: デプロイ失敗のリポジトリ数。残りは承認・判断・マージ待ち */
  deployFailed: number;
};

export function countReleaseNeedsUser(
  releaseStatuses: RepositoryReleaseStatus[] | null,
): ReleaseNeedsUserCounts | null {
  if (releaseStatuses === null) return null;
  const needing = releaseStatuses.filter((releaseStatus) => releaseStatus.needsUser === true);
  return {
    total: needing.length,
    deployFailed: needing.filter((releaseStatus) => releaseStatus.failedWorkflow === "deploy").length,
  };
}

export function describeReleaseNeedsUser(counts: ReleaseNeedsUserCounts | null): string {
  if (counts === null || counts.total === 0) return "手が要るものはありません";
  const waiting = counts.total - counts.deployFailed;
  return [
    waiting > 0 ? `承認・判断・マージ待ち${waiting}件` : null,
    counts.deployFailed > 0 ? `デプロイ失敗${counts.deployFailed}件` : null,
  ]
    .filter((part) => part !== null)
    .join("・");
}
