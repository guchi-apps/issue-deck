import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { getProjectLocation } from "@/lib/github/project-location";
import {
  addProjectItem,
  fetchOpenIssueNodes,
  fetchProjectItems,
  fetchProjectStatusField,
  updateProjectItemStatus,
} from "@/lib/github/projects-api";
import {
  CLOSE_TERMINAL_SOURCE_STATUSES,
  getProgressStatusDef,
  matchProjectStatus,
} from "@/lib/issue-progress";

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

export type ProjectItemBackfillResult = {
  /** 盤面へ新しく載せたIssueの件数 */
  added: number;
  /** Projectを使わない設定（環境変数未設定）でスキップしたか */
  skipped: boolean;
};

/**
 * マルチエージェント運用の対象リポジトリのopenなIssueのうち、盤面に載っていないものを追加する（#1036）。
 *
 * **Project WorkflowsのAuto-addには頼れない。** GitHub Freeでは1リポジトリ、Teamでも5リポジトリ
 * までしか設定できず（1ワークフローにつき1リポジトリ）、「対象はマルチエージェント対応リポジトリ
 * 全体」という#991の目標に届かない。
 *
 * **対象は`hasClaudeWorkflow`が真のリポジトリに限る。** issue-deckは20以上のリポジトリに接続して
 * おり、全部を載せると盤面が埋まる。共有ワークフローを持つ＝進捗を報告してくるリポジトリだけを扱う。
 * closedなIssueも追加しない（過去分で埋まるため）。
 *
 * @param installationId GitHub Appのインストールid（Projectの所有org側のもの）
 */
export async function addMissingProjectItems(
  installationId: number,
): Promise<ProjectItemBackfillResult> {
  const location = getProjectLocation();
  if (!location) return { added: 0, skipped: true };

  const token = await getInstallationToken(installationId);
  const project = await fetchProjectStatusField(location.owner, location.number, token);
  if (!project) return { added: 0, skipped: false };

  const items = await fetchProjectItems(location.owner, location.number, token);

  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
      archived: false,
      installation: { installationId },
    },
    select: { id: true, githubRepositoryId: true, ownerLogin: true, name: true },
  });

  const readyStatus = getProgressStatusDef("ready").projectStatus;
  const readyOptionId = project.optionIdByName.get(readyStatus);

  let added = 0;
  for (const repository of repositories) {
    const onBoard = new Set(
      items
        .filter((item) => item.repositoryDatabaseId === repository.githubRepositoryId)
        .map((item) => item.issueNumber),
    );

    const openIssues = await fetchOpenIssueNodes(repository.ownerLogin, repository.name, token);
    for (const issue of openIssues) {
      if (onBoard.has(issue.number)) continue;
      const item = await addProjectItem(project.projectId, issue.nodeId, token);
      if (!item) continue;
      added += 1;

      // **Statusを明示的に`Ready`にする。** 追加直後は未設定になることがあり、その状態から
      // カードを動かしても遷移前が`Ready`にならず、カンバン起点の起動（Phase 3）が働かない
      // （resolveDispatchModeは`Ready`からの遷移だけを対象にする）。
      let status = item.status;
      if (status === null && readyOptionId) {
        await updateProjectItemStatus(
          {
            projectId: project.projectId,
            itemId: item.itemId,
            fieldId: project.fieldId,
            optionId: readyOptionId,
          },
          token,
        );
        status = readyStatus;
      }

      // **DBへも同じ値を書く（#1132）。** Projectだけ`Ready`にしてDBを`null`のままにすると、
      // カンバン起点の起動が`from`にDBの値を使うため、**載せた直後の最初のドラッグが
      // `from = null`になって除外される**（起動しないのは1回目だけで、そのドラッグがDBを
      // 更新するため2回目以降は動く。エラーも出ないので気づきにくい）。
      //
      // この後に走る`syncProjectStatuses`もProjectを読み直してDBへ書くが、追加直後の
      // アイテムがまだ`Ready`を返すとは限らず、当てにできない。`reportProgressStatus`が
      // Projectを書いた直後にDBも更新しているのと同じ形に揃える。
      await db.issue.updateMany({
        where: { repositoryId: repository.id, number: issue.number },
        data: { projectStatus: status, projectItemId: item.itemId },
      });
    }
  }

  return { added, skipped: false };
}

export type StrandedIssueCleanupResult = {
  /** 終端（`Closed`）へ寄せたIssueの件数 */
  closed: number;
  /** Projectを使わない設定、またはProjectに`Closed`の選択肢が無くてスキップしたか */
  skipped: boolean;
};

/**
 * closedなのにStatusが`Planning`・`Implementation`・`Develop PR`に取り残されているIssueを、
 * 終端（`Closed`）へまとめて寄せる（#1856）。
 *
 * 通常はIssueのcloseを受けたWebhook（`app/api/webhooks/github/route.ts`）がその場で遷移させる。
 * こちらは**Webhookが届く前から溜まっていた既存分の回収**と、**取りこぼしへの恒久的な安全網**を
 * 兼ねる。`syncProjectStatuses`・`addMissingProjectItems`と同じく再同期から呼ばれる。
 *
 * 判定に必要な「Issueがclosedか」と「今のStatus」は`fetchProjectItems`が返すスナップショットに
 * 両方入っているため、盤面を1回読むだけで済み、Issueごとの追加の問い合わせは要らない。
 *
 * @param installationId GitHub Appのインストールid（Projectの所有org側のもの）
 */
export async function closeStrandedProjectItems(
  installationId: number,
): Promise<StrandedIssueCleanupResult> {
  const location = getProjectLocation();
  if (!location) return { closed: 0, skipped: true };

  const token = await getInstallationToken(installationId);
  const project = await fetchProjectStatusField(location.owner, location.number, token);
  if (!project) return { closed: 0, skipped: true };

  const terminalStatus = getProgressStatusDef("closed").projectStatus;
  const terminalOptionId = project.optionIdByName.get(terminalStatus);
  // Project側に`Closed`の選択肢を足すまでは何もしない。ここで別のStatusで代用すると
  // 意味の違う状態が混ざるため、選択肢が現れるまで待つ（進捗はそのまま残る）
  if (!terminalOptionId) return { closed: 0, skipped: true };

  const items = await fetchProjectItems(location.owner, location.number, token);

  const repositories = await db.repository.findMany({
    where: { installation: { installationId } },
    select: { id: true, githubRepositoryId: true },
  });
  const repositoryIdByGithubId = new Map(
    repositories.map((repository) => [repository.githubRepositoryId, repository.id]),
  );

  let closed = 0;
  for (const item of items) {
    if (item.issueOpen) continue;
    if (!item.status) continue;
    const current = matchProjectStatus(item.status);
    if (!current || !CLOSE_TERMINAL_SOURCE_STATUSES.includes(current)) continue;

    await updateProjectItemStatus(
      {
        projectId: project.projectId,
        itemId: item.itemId,
        fieldId: project.fieldId,
        optionId: terminalOptionId,
      },
      token,
    );
    closed += 1;

    // `reportProgressStatus`と同じく、Projectを書いたらDBのキャッシュも揃える。
    // issue-deckが接続していないリポジトリのIssueは対象外（Statusだけ直して終わる）
    const repositoryId = repositoryIdByGithubId.get(item.repositoryDatabaseId);
    if (!repositoryId) continue;
    await db.issue.updateMany({
      where: { repositoryId, number: item.issueNumber },
      data: { projectStatus: terminalStatus, projectItemId: item.itemId },
    });
  }

  return { closed, skipped: false };
}
