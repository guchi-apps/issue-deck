import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { getProjectLocation } from "@/lib/github/project-location";
import {
  fetchProjectItems,
  fetchProjectStatusField,
  findIssueProjectState,
} from "@/lib/github/projects-api";
import { matchProjectStatus, type ProgressStatusKey } from "@/lib/issue-progress";

/**
 * 進捗の問い合わせ（#991 Phase 5・#1010）。**進捗ラベルを廃止したことで、
 * 「いま何がどの段階にあるか」をGitHub側だけで知る手段が無くなった**ため、
 * `GET /api/progress`の実体としてここに置く。
 *
 * Phase 4までは各ワークフローが`gh issue list --label "03.d:marge"`のようにラベルで
 * 探していた。ラベルが無くなった以上、探し先はProjectしかない。そしてProjectへの
 * 読み書きはissue-deckへ一本化する（docs/progress-status-architecture.md「中核の判断」）
 * ため、ワークフローはProjectを直接引かずこのAPIを経由する。Projects v2の権限を
 * 各リポジトリのワークフローへ配らずに済ませるという判断はPhase 2から変わらない。
 */

/** 対象リポジトリがissue-deckに接続されていない場合はnullを返す */
async function resolveRepositoryContext(repositoryFullName: string) {
  const location = getProjectLocation();
  if (!location) return null;

  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;

  const token = await getInstallationToken(repository.installation.installationId);
  return { location, repository, token };
}

export type IssueProgressQueryResult =
  | { available: true; status: ProgressStatusKey | null }
  /** Project連携が無効・リポジトリ未接続・Projectの構成が想定と違う等で答えられない */
  | { available: false; reason: "project_disabled" | "unknown_repository" | "unknown_status" };

/**
 * 1つのIssueの現在の進捗を返す。盤面に載っていなければ`status: null`。
 *
 * `reusable-issue-dispatch.yml`の実行モード判定が使う。あちらは以前
 * `02.wip`・`03.d:marge`の有無を見ていた（#112・#905）。
 *
 * **DBの`projectStatus`ではなくGitHubへ問い合わせる。** 判定の正しさをDBの鮮度に
 * 依存させないためで、`reportProgressStatus`が書き込み側で同じ方針を採っているのと揃えている。
 */
export async function queryIssueProgressStatus(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<IssueProgressQueryResult> {
  const context = await resolveRepositoryContext(params.repositoryFullName);
  if (!context) {
    return {
      available: false,
      reason: getProjectLocation() ? "unknown_repository" : "project_disabled",
    };
  }
  const { location, repository, token } = context;

  const field = await fetchProjectStatusField(location.owner, location.number, token);
  if (!field) return { available: false, reason: "unknown_status" };

  const state = await findIssueProjectState(
    repository.ownerLogin,
    repository.name,
    params.issueNumber,
    field.projectId,
    token,
  );
  // GitHub上にIssueが無い・盤面へ未登録は、どちらも「進捗が始まっていない」として扱う
  const status = state?.item?.status ?? null;
  return { available: true, status: status ? matchProjectStatus(status) : null };
}

export type IssueListQueryResult =
  | { available: true; issues: number[] }
  | { available: false; reason: "project_disabled" | "unknown_repository" | "unknown_status" };

/**
 * 指定した進捗状態にある**openな**Issueの番号を、リポジトリ単位で返す（昇順）。
 *
 * develop→mainのリリース関連ジョブ（`main-pr-in-progress`・`main-pr-merged`）と
 * `main-pr-in-progress`・`main-pr-merged`が使う。以前は`gh issue list --label "05.develop"`のように
 * ラベルで探していた部分にあたる。
 *
 * **closedなIssueは返さない。** 元のラベル検索が`--state open`で絞っていたのと揃える。
 * closedのまま`Done`以外のStatusで盤面に残っているIssue（人が直接closeした等）を
 * リリースの対象に含めると、閉じたIssueを閉じ直すだけの無駄な操作になる。
 */
export async function queryIssuesByProgressStatus(params: {
  repositoryFullName: string;
  statuses: ProgressStatusKey[];
}): Promise<IssueListQueryResult> {
  const context = await resolveRepositoryContext(params.repositoryFullName);
  if (!context) {
    return {
      available: false,
      reason: getProjectLocation() ? "unknown_repository" : "project_disabled",
    };
  }
  const { location, repository, token } = context;

  const wanted = new Set(params.statuses);
  const items = await fetchProjectItems(location.owner, location.number, token);
  const numbers = items
    .filter((item) => item.repositoryDatabaseId === repository.githubRepositoryId)
    .filter((item) => item.issueOpen)
    .filter((item) => {
      const key = item.status ? matchProjectStatus(item.status) : null;
      return key !== null && wanted.has(key);
    })
    .map((item) => item.issueNumber);

  return { available: true, issues: [...new Set(numbers)].sort((a, b) => a - b) };
}
