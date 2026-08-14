import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { getProjectLocation } from "@/lib/github/project-location";
import {
  addProjectItem,
  fetchProjectStatusField,
  findIssueProjectState,
  updateProjectItemStatus,
  type ProjectStatusField,
} from "@/lib/github/projects-api";
import { getProgressStatusDef, type ProgressStatusKey } from "@/lib/issue-progress";

/**
 * 進捗の変化をGitHub Projects v2のStatusへ反映する（#991 Phase 2）。
 *
 * **実行基盤（GitHub Actions・ミニPC・VS Code・Claudeアプリ）はProjectを直接書かず、
 * ここへ報告する。** Projects v2の書き込み権限を持つのはissue-deckのGitHub Appだけでよくなり、
 * 対象リポジトリや実行基盤が増えてもトークンを配らずに済む。設計の一次情報源は
 * docs/progress-status-architecture.md。
 */

/** 報告の結果。呼び出し側は失敗しても処理を止めない前提のため、理由を返して判断材料にする */
export type ProgressReportResult =
  | { applied: true; from: string | null; to: string }
  /** PROJECT_V2_OWNER・PROJECT_V2_NUMBERが未設定でProject連携そのものを行わない */
  | { applied: false; reason: "project_disabled" }
  /** issue-deckが接続していないリポジトリ */
  | { applied: false; reason: "unknown_repository" }
  /** ProjectにStatusフィールド（単一選択）が無い、または対象の選択肢が無い */
  | { applied: false; reason: "unknown_status" }
  /** GitHub上にIssueが無い（削除・移動済み）か、Projectへの追加に失敗した */
  | { applied: false; reason: "not_in_project" }
  /** closedなIssueを`Done`より手前へ巻き戻す報告だったため書かなかった（#1348） */
  | { applied: false; reason: "issue_closed" }
  /** 既に同じStatusだったため書き込まなかった */
  | { applied: false; reason: "unchanged" };

/**
 * Statusフィールドのid群のキャッシュ。Projectの選択肢を編集しない限り不変だが、
 * 編集された場合でも再起動を待たずに追随できるようTTLを付ける。
 * 報告はラベル遷移のたびに走るため、毎回引くとGraphQLの呼び出しが倍になる。
 */
const STATUS_FIELD_CACHE_MS = 10 * 60_000;
let statusFieldCache: { key: string; value: ProjectStatusField; expiresAt: number } | null = null;

async function getStatusField(
  owner: string,
  projectNumber: number,
  token: string,
  now: number,
): Promise<ProjectStatusField | null> {
  const key = `${owner}/${projectNumber}`;
  if (statusFieldCache && statusFieldCache.key === key && statusFieldCache.expiresAt > now) {
    return statusFieldCache.value;
  }

  const field = await fetchProjectStatusField(owner, projectNumber, token);
  if (!field) return null;

  statusFieldCache = { key, value: field, expiresAt: now + STATUS_FIELD_CACHE_MS };
  return field;
}

/** テスト用。モジュールスコープのキャッシュを捨てる */
export function clearProjectStatusFieldCache(): void {
  statusFieldCache = null;
}

/**
 * 報告されたIssueの進捗をProjectのStatusへ書き込み、DBのキャッシュも同時に更新する。
 *
 * DBを`projects_v2_item` Webhookの到達を待たずに更新するのは、報告直後に画面を開いても
 * 古い状態が見えないようにするため。Webhookが後から届いても同じ値を書くだけで冪等。
 */
export async function reportProgressStatus(params: {
  repositoryFullName: string;
  issueNumber: number;
  status: ProgressStatusKey;
}): Promise<ProgressReportResult> {
  const location = getProjectLocation();
  if (!location) return { applied: false, reason: "project_disabled" };

  const repository = await db.repository.findFirst({
    where: { fullName: params.repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return { applied: false, reason: "unknown_repository" };

  // 報告されたリポジトリ側のインストールトークンを使う。Issueの所属Projectを引くのに
  // リポジトリへのアクセスが要るため。**Projectの所有org（PROJECT_V2_OWNER）と対象リポジトリが
  // 同じorgにある前提**で、異なる場合はProjectが見えず`unknown_status`になる。
  // Appのorganization permission「Projects」はReadではなくRead and writeが要る（Phase 1は
  // 読み取りだけだったため一段上がる）。
  const token = await getInstallationToken(repository.installation.installationId);

  const field = await getStatusField(location.owner, location.number, token, Date.now());
  if (!field) return { applied: false, reason: "unknown_status" };

  const targetStatus = getProgressStatusDef(params.status).projectStatus;
  const optionId = field.optionIdByName.get(targetStatus);
  // Project側の選択肢名がPROGRESS_STATUSESとズレている場合。DBだけ書き換えると
  // Projectと食い違ったままになるため、何もせず理由を返す
  if (!optionId) return { applied: false, reason: "unknown_status" };

  const state = await findIssueProjectState(
    repository.ownerLogin,
    repository.name,
    params.issueNumber,
    field.projectId,
    token,
  );
  // GitHub上にIssueが存在しない（削除・移動済み）
  if (!state) return { applied: false, reason: "not_in_project" };

  // closedなIssueの進捗は`Done`以外へ動かさない（#1348）。
  //
  // `Done`でcloseされた後も、同じブランチ（issue-<番号>）からdevelopへPRがマージされると
  // issue-labels.ymlのdevelop-pr-mergedがブランチ名だけを見て`develop`を報告するため、
  // closedのままStatusが`Develop`へ巻き戻る。**この状態からは二度と`Done`へ戻れない。**
  // 一括遷移の対象を引く`queryIssuesByProgressStatus`はopenなIssueしか返さず、以降の
  // リリースが何度走ってもこのIssueを拾わないため、盤面の「本番へ反映する内容」に
  // 恒久的に残り続ける（#1181が実際にこうなった）。
  //
  // `done`だけを通すのは、main-pr-mergedが「closeしてから`done`を報告する」順序で
  // 動いているため（.github/workflows/reusable-issue-labels.yml）。ここで一律に弾くと
  // 正規のDone遷移そのものが書き込めなくなる。
  if (!state.issueOpen && params.status !== "done") {
    return { applied: false, reason: "issue_closed" };
  }

  // 盤面に無ければ載せる。Project WorkflowsのAuto-addはプランごとに設定できる
  // リポジトリ数の上限があり、対象リポジトリ全体には届かないため（#1036）
  const item = state.item ?? (await addProjectItem(field.projectId, state.issueNodeId, token));
  if (!item) return { applied: false, reason: "not_in_project" };

  if (item.status === targetStatus) {
    // 書き込まなくてもDBのキャッシュが遅れている可能性はあるため、そちらだけ揃えておく
    await db.issue.updateMany({
      where: { repositoryId: repository.id, number: params.issueNumber },
      data: { projectStatus: targetStatus, projectItemId: item.itemId },
    });
    return { applied: false, reason: "unchanged" };
  }

  await updateProjectItemStatus(
    { projectId: field.projectId, itemId: item.itemId, fieldId: field.fieldId, optionId },
    token,
  );

  await db.issue.updateMany({
    where: { repositoryId: repository.id, number: params.issueNumber },
    data: { projectStatus: targetStatus, projectItemId: item.itemId },
  });

  return { applied: true, from: item.status, to: targetStatus };
}
