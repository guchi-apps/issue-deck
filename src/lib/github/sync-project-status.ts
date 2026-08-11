import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { getProjectLocation } from "@/lib/github/project-location";
import {
  fetchProjectItems,
  fetchProjectStatusField,
  updateProjectItemStatus,
} from "@/lib/github/projects-api";
import { getProgressStatusDef, matchProgressLabels } from "@/lib/issue-progress";

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

export type ProjectStatusReconcileResult = {
  /** ラベルに合わせてStatusを書き換えたIssueの件数 */
  corrected: number;
  /** Projectを使わない設定（環境変数未設定）でスキップしたか */
  skipped: boolean;
};

/**
 * 進捗ラベルとProject Statusのズレを、**ラベルを正としてProjectへ書き戻す**（#991 Phase 2）。
 *
 * Phase 2はラベルとStatusの二重運用期で、ラベルはActionsが確実に維持し、Statusはその写しになる
 * （最終的にStatusを唯一の正にするのはPhase 5）。したがってこの段階での是正方向はラベル → Status。
 * 報告APIの取りこぼし（issue-deckの停止中・疎通失敗）を再同期で回収するための経路。
 *
 * **進捗ラベルが1つも付いていないIssueは対象外にする。** ラベル無し＝`ready`とみなして
 * 書き戻すと、人がカンバンでドラッグした結果（Phase 3で起動トリガーになる）を再同期のたびに
 * 巻き戻してしまうため。ラベルが明示的に付いているものだけを写す。
 *
 * @param installationId GitHub Appのインストールid（Projectの所有org側のもの）
 */
export async function reconcileProjectStatusesFromLabels(
  installationId: number,
): Promise<ProjectStatusReconcileResult> {
  const location = getProjectLocation();
  if (!location) return { corrected: 0, skipped: true };

  const token = await getInstallationToken(installationId);
  const field = await fetchProjectStatusField(location.owner, location.number, token);
  if (!field) return { corrected: 0, skipped: false };

  const items = await fetchProjectItems(location.owner, location.number, token);

  const repositoryIds = [...new Set(items.map((item) => item.repositoryDatabaseId))];
  const repositories = await db.repository.findMany({
    where: { githubRepositoryId: { in: repositoryIds } },
    select: { id: true, githubRepositoryId: true },
  });
  const repositoryIdByGithubId = new Map(
    repositories.map((repository) => [repository.githubRepositoryId, repository.id]),
  );

  // Projectに載っているIssueのラベルをまとめて引く（アイテムごとに問い合わせない）
  const issues = await db.issue.findMany({
    where: {
      OR: items
        .map((item) => {
          const repositoryId = repositoryIdByGithubId.get(item.repositoryDatabaseId);
          return repositoryId ? { repositoryId, number: item.issueNumber } : null;
        })
        .filter((where): where is { repositoryId: string; number: number } => where !== null),
    },
    select: { repositoryId: true, number: true, labels: { select: { name: true } } },
  });
  const labelsByKey = new Map(
    issues.map((issue) => [`${issue.repositoryId}#${issue.number}`, issue.labels]),
  );

  let corrected = 0;
  for (const item of items) {
    const repositoryId = repositoryIdByGithubId.get(item.repositoryDatabaseId);
    if (!repositoryId) continue;

    const labels = labelsByKey.get(`${repositoryId}#${item.issueNumber}`);
    if (!labels) continue;

    // matchProgressLabelsはIssueLabel型（color・descriptionを持つ）を受けるが、参照するのは
    // nameだけのため、DBから引いたnameのみの配列を渡している
    const labelStatus = matchProgressLabels(
      labels.map((label) => ({ name: label.name, color: "", description: null })),
    );
    if (labelStatus === "ready") continue;

    const targetStatus = getProgressStatusDef(labelStatus).projectStatus;
    if (item.status === targetStatus) continue;

    const optionId = field.optionIdByName.get(targetStatus);
    if (!optionId) continue;

    await updateProjectItemStatus(
      { projectId: field.projectId, itemId: item.itemId, fieldId: field.fieldId, optionId },
      token,
    );
    await db.issue.updateMany({
      where: { repositoryId, number: item.issueNumber },
      data: { projectStatus: targetStatus, projectItemId: item.itemId },
    });
    corrected += 1;
  }

  return { corrected, skipped: false };
}
