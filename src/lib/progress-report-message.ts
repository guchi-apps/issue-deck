/**
 * 進捗報告（`reportProgressStatus`）が書き込めなかった理由と、その画面表示用の日本語。
 *
 * **`lib/github/report-progress.ts`から切り出した純粋モジュール。** あちらは`db`と
 * GitHub Appの認証を引きずるためクライアントコンポーネントからimportできないが、
 * 右パネルの進捗セレクト（`components/dashboard/issue-properties-panel.tsx`）は
 * 失敗理由をユーザーへ出す必要がある。依存の向きをサーバー→この純粋モジュールの一方向に
 * 保つための分離で、`lib/dispatch/dispatch-job.ts`と`lib/dispatch/jobs.ts`の分け方と同じ。
 */

export type ProgressReportFailureReason =
  /** PROJECT_V2_OWNER・PROJECT_V2_NUMBERが未設定でProject連携そのものを行わない */
  | "project_disabled"
  /** issue-deckが接続していないリポジトリ */
  | "unknown_repository"
  /** ProjectにStatusフィールド（単一選択）が無い、または対象の選択肢が無い */
  | "unknown_status"
  /** GitHub上にIssueが無い（削除・移動済み）か、Projectへの追加に失敗した */
  | "not_in_project"
  /** closedなIssueを終端（`Done`・`Closed`）より手前へ巻き戻す報告だったため書かなかった（#1348） */
  | "issue_closed"
  /** 報告側が指定した遷移元（`onlyFrom`）に現在のStatusが含まれず、対象外だった（#1856） */
  | "status_mismatch"
  /** 既に同じStatusだったため書き込まなかった */
  | "unchanged";

const MESSAGES: Record<ProgressReportFailureReason, string | null> = {
  project_disabled: "GitHub Projectsとの連携が設定されていないため、進捗を変更できません。",
  unknown_repository: "このリポジトリはissue-deckに接続されていないため、進捗を変更できません。",
  unknown_status: "GitHub Projects側にこのステータスの選択肢が見つかりませんでした。",
  not_in_project: "GitHub Projectsへの登録に失敗したため、進捗を変更できませんでした。",
  issue_closed: "クローズ済みのIssueは「本番反映済」「対応終了」以外の進捗へ変更できません。",
  // 遷移元を限定した報告（close起点の自動遷移）が対象外だっただけで、何も壊れていない。
  // 画面の進捗セレクトはonlyFromを指定しないため、そもそもここには来ない
  status_mismatch: null,
  // 既に同じStatusだった場合は何も壊れていない。エラーとして見せない
  unchanged: null,
};

/**
 * 失敗理由を画面表示用の日本語にする。**エラーとして見せる必要が無いものは`null`**。
 * 未知の理由（サーバー側で追加されたがこちらへ反映していない）も汎用の文言で拾う。
 */
export function describeProgressReportFailure(reason: string): string | null {
  if (reason in MESSAGES) {
    return MESSAGES[reason as ProgressReportFailureReason];
  }
  return "進捗を変更できませんでした。";
}
