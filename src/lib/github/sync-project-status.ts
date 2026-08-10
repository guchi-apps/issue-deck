import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchProjectItems } from "@/lib/github/projects-api";

/**
 * 進捗管理に使うGitHub Projects v2の場所。未設定ならProject連携そのものを行わない（#991）。
 *
 * Projectを使わない環境（他リポジトリへの展開先・プレビュー環境など）でも壊れないよう、
 * 環境変数が欠けているときは黙って何もしない設計にしている。
 */
function getProjectLocation(): { owner: string; number: number } | null {
  const owner = process.env.GITHUB_PROJECT_OWNER;
  const rawNumber = process.env.GITHUB_PROJECT_NUMBER;
  if (!owner || !rawNumber) return null;

  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    console.error("[sync-project-status] GITHUB_PROJECT_NUMBER が不正です", rawNumber);
    return null;
  }
  return { owner, number };
}

export type ProjectStatusSyncResult = {
  /** Statusを反映したIssueの件数 */
  updated: number;
  /** Projectから外れてStatusを消したIssueの件数 */
  cleared: number;
  /** Projectを使わない設定（環境変数未設定）でスキップしたか */
  skipped: boolean;
};

/**
 * Projectの全アイテムを取得し、対応するIssueの`projectStatus`・`projectItemId`を更新する。
 *
 * 通常はWebhook（projects_v2_item）で随時反映されるが、Webhookの取りこぼしや初回導入時の
 * バックフィルのためにこちらも用意する。Projectに載っていないIssueはStatusをnullへ戻し、
 * 進捗ラベル起点の判定へフォールバックさせる。
 *
 * @param installationId GitHub Appのインストールid（Projectの所有org側のもの）
 */
export async function syncProjectStatuses(
  installationId: number,
): Promise<ProjectStatusSyncResult> {
  const location = getProjectLocation();
  if (!location) return { updated: 0, cleared: 0, skipped: true };

  const token = await getInstallationToken(installationId);
  const items = await fetchProjectItems(location.owner, location.number, token);

  // repositoryDatabaseId -> DBのrepository.id を1回だけ引いて使い回す
  const repositoryIds = [...new Set(items.map((item) => item.repositoryDatabaseId))];
  const repositories = await db.repository.findMany({
    where: { githubRepositoryId: { in: repositoryIds } },
    select: { id: true, githubRepositoryId: true },
  });
  const repositoryIdByGithubId = new Map(
    repositories.map((repository) => [repository.githubRepositoryId, repository.id]),
  );

  let updated = 0;
  const syncedIssueKeys: { repositoryId: string; number: number }[] = [];

  for (const item of items) {
    const repositoryId = repositoryIdByGithubId.get(item.repositoryDatabaseId);
    // issue-deckが接続していないリポジトリのIssueは対象外
    if (!repositoryId) continue;

    const result = await db.issue.updateMany({
      where: { repositoryId, number: item.issueNumber },
      data: { projectStatus: item.status, projectItemId: item.itemId },
    });
    if (result.count > 0) {
      updated += result.count;
      syncedIssueKeys.push({ repositoryId, number: item.issueNumber });
    }
  }

  // Projectから外れたIssueのStatusを消す。対象はProjectに載っているリポジトリに限る
  // （Project未導入のリポジトリのIssueまで触らないようにするため）
  const touchedRepositoryIds = [...new Set(syncedIssueKeys.map((key) => key.repositoryId))];
  let cleared = 0;
  for (const repositoryId of touchedRepositoryIds) {
    const numbersInProject = syncedIssueKeys
      .filter((key) => key.repositoryId === repositoryId)
      .map((key) => key.number);
    const result = await db.issue.updateMany({
      where: {
        repositoryId,
        number: { notIn: numbersInProject },
        NOT: { projectStatus: null },
      },
      data: { projectStatus: null, projectItemId: null },
    });
    cleared += result.count;
  }

  return { updated, cleared, skipped: false };
}
