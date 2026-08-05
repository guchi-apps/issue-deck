import type { IssueStateFilter } from "@/hooks/use-issue-filters";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import type { IssueLabel, LabelNavViewId } from "@/types/issue";

/** ユーザーの確認・指示が必要であることを示すラベル */
export const CHECK_USER_LABEL = "00.check-user";

/** 実装前の計画承認待ちであることを示すラベル */
export const PLAN_REQUIRED_LABEL = "21.plan-required";

/** developへのPR作成・マージ中であることを示すワークフロー状況ラベル */
const D_MARGE_LABEL = "03.d:marge";

/** mainへのPR作成・マージ中であることを示すワークフロー状況ラベル */
const M_MARGE_LABEL = "07.m:marge";

export function isApprovalPending(labels: IssueLabel[]): boolean {
  return labels.some((label) => label.name === CHECK_USER_LABEL);
}

export type LabelFilterPreset = {
  key: LabelNavViewId;
  label: string;
  labels: string[];
  /**
   * プリセット選択時に適用するstateフィルター（省略時はstateを変更しない）。
   * 09.mainはマージ完了と同時にissueをcloseする運用（CLAUDE.md）のため、
   * 「直近main反映済み」プリセットはデフォルトのopen絞り込みのままだと該当issueが
   * 出てこない。
   */
  state?: IssueStateFilter;
};

/**
 * 運用ラベルに基づく定型の絞り込みプリセット。
 * サイドメニュー・スマホのクイックビューでは、これをビュー（viewクエリ）として扱う
 * （@/lib/nav-views の labelNavViews）。
 */
export const LABEL_FILTER_PRESETS: readonly LabelFilterPreset[] = [
  { key: "check-user", label: "ユーザーの確認待ち", labels: [CHECK_USER_LABEL] },
  {
    key: "in-progress",
    label: "実行中",
    labels: [WORKFLOW_STEPS[0].labelName, WORKFLOW_STEPS[1].labelName],
  },
  {
    key: "release-pending",
    label: "本番反映待ち",
    labels: [WORKFLOW_STEPS[2].labelName, WORKFLOW_STEPS[3].labelName],
  },
  {
    key: "recently-merged",
    label: "直近に本番反映",
    labels: [WORKFLOW_STEPS[4].labelName],
    state: "all",
  },
];

/** 現在選択中のラベル集合が、指定したプリセットとちょうど一致しているかを判定する */
export function isLabelFilterPresetActive(labels: string[], preset: LabelFilterPreset): boolean {
  return labels.length === preset.labels.length && preset.labels.every((name) => labels.includes(name));
}

export type LabelFilterPresetSelection = {
  labels: string[];
  state?: IssueStateFilter;
};

/**
 * プリセットボタン押下時に適用すべきラベル・stateフィルターを返す。
 * 選択中なら解除し、プリセットがstateを指定していれば併せてデフォルト（open）へ戻す。
 */
export function resolveLabelFilterPresetSelection(
  preset: LabelFilterPreset,
  isActive: boolean,
): LabelFilterPresetSelection {
  if (isActive) {
    return preset.state ? { labels: [], state: "open" } : { labels: [] };
  }
  return preset.state ? { labels: preset.labels, state: preset.state } : { labels: preset.labels };
}

/**
 * 00.check-userかつワークフロー状況が03.d:marge/07.m:margeの場合、PRマージ待ち
 * （GitHub上で人間が直接マージする必要があり、@claudeコメントでの再開対象ではない）と判定する。
 */
export function isMergeApprovalPending(labels: IssueLabel[]): boolean {
  if (!isApprovalPending(labels)) return false;
  const stepIndex = getWorkflowStepIndex(labels);
  if (stepIndex === null) return false;
  const stepLabel = WORKFLOW_STEPS[stepIndex].labelName;
  return stepLabel === D_MARGE_LABEL || stepLabel === M_MARGE_LABEL;
}

/** 承認時に外すラベル名の配列を返す（00.check-userに加え、計画承認待ちなら21.plan-requiredも外す） */
export function labelsAfterApproval(labels: IssueLabel[]): string[] {
  return labels
    .map((label) => label.name)
    .filter((name) => name !== CHECK_USER_LABEL && name !== PLAN_REQUIRED_LABEL);
}

/**
 * 却下（UI上のボタン表記は「修正」）時に外すラベル名の配列を返す（00.check-userのみを
 * 外す。21.plan-requiredは計画の再提示が必要なため残す）
 */
export function labelsAfterRejection(labels: IssueLabel[]): string[] {
  return labels.map((label) => label.name).filter((name) => name !== CHECK_USER_LABEL);
}

/**
 * 承認ボタン押下時、ラベル更新に続けて投稿する定型コメント本文
 * （claude-issue-dispatch.ymlの@claudeトリガーに反応する）。
 *
 * ラベル更新はissue-deckのGitHub App（インストールトークン）で行うためGitHub上は
 * issue-deck[bot]の操作として記録され、issues.unlabeledイベントだけでは実際に
 * 承認操作をした人間を特定できず、ワークフロー側の自己ループ防止ロジックにより
 * 実装が再開されない（#173）。GitHub Appの人力アプリ操作であっても
 * 個人のGitHubアカウントで投稿されるコメント（POST /api/issues/comments、
 * user.githubAccessToken使用）を承認ラベル更新の直後に送ることで、
 * issue_commentトリガー経由で実装を確実に再開させる。
 *
 * 21.plan-requiredによる計画承認待ちの場合と、それ以外（画面確認待ち・フォールバック
 * エラー通知など）の汎用確認待ちの場合とで、「計画」という語を含むかどうかの文言を変える。
 */
export function approveCommentBody(labels: IssueLabel[]): string {
  const isPlanApproval = labels.some((label) => label.name === PLAN_REQUIRED_LABEL);
  return isPlanApproval
    ? "@claude 計画を承認しました。実装を進めてください。"
    : "@claude 確認しました。実装を進めてください。";
}

/**
 * フォールバック通知（計画コメント投稿・実装結果報告のいずれも確認できなかった場合の通知）に対して、
 * 「続きを実装・調査を依頼」ボタン押下時に投稿する定型コメント本文。
 *
 * ボタン押下時はこのコメント投稿に先立ち、labelsAfterRejection（00.check-userのみ除去、
 * 21.plan-requiredは残す）でラベルを更新する（#330）。00.check-userを残したままだと、
 * 投稿直後は直近コメントがこの継続依頼コメントになるためisFallbackNoticeComment判定が
 * 外れ、UI上フォールバック専用のボタンではなく通常の承認・修正・取り下げボタンに戻って
 * 表示されてしまう不具合があった。ラベル更新はissue-deckのGitHub App経由でissues.unlabeled
 * イベントとして記録されるが、claude-issue-dispatch.yml側の自己ループ防止ロジックにより
 * Botの操作は無視されるため実装の再開はトリガーされず、続けて投稿する本コメント
 * （issue_commentイベント）経由でのみ再開される。21.plan-requiredを残すため、
 * 計画フェーズ・分割フェーズでのフォールバック（ブランチ未作成）に対する継続依頼でも
 * 従来どおり計画の再試行として扱われる。
 */
export function requestContinuationCommentBody(): string {
  return "@claude 続きを実装・調査してください。";
}

/**
 * PRマージ待ち画面（isMergeApprovalPending）の「修正を依頼する」ボタン押下時に投稿する
 * コメント本文。ボタン押下時はこのコメント投稿に先立ち、handleReject等と同様
 * labelsAfterRejection（00.check-userのみ除去、21.plan-requiredは残す）でラベルを
 * 更新する。修正コミットが積まれている間はユーザー確認待ちではないため、他の操作と
 * 揃えて00.check-userを外す（#409）。claude-issue-dispatch.ymlは対応issueのブランチが
 * 既にありdevelopへのPRがOPENであればmode=additionalとして扱うため、このコメント投稿
 * により既存PRへの追加コミットが行われる（#376）。再度ユーザー確認が必要な状態になった
 * 場合は、追加コミットのpushがclaude-review-develop.ymlを再発火させ、そちらのrisk-check/
 * claude-reviewが必要に応じて00.check-userを再付与する。
 */
export function requestPrFixCommentBody(reason: string): string {
  const trimmed = reason.trim();
  return trimmed ? `@claude ${trimmed}` : "@claude PRの内容を見直して修正してください。";
}

/**
 * 承認・修正依頼・継続依頼・PR修正依頼の各操作は「ラベル更新→コメント投稿」の順で行うが、
 * コメント投稿（個人のGitHub OAuthトークン使用）はトークン失効時に失敗しうる（#421）。
 * その場合ラベル更新のみが反映され「ラベル上は操作済みに見えるが実装は再開されない」不整合
 * 状態になるため、呼び出し側はラベルをロールバックしたうえで、次に取るべき行動が分かるよう
 * 元のエラーメッセージにこの案内を追記する。
 */
export function withRollbackNotice(baseMessage: string): string {
  return `${baseMessage} ラベルの変更は取り消しました。GitHubからログアウトし、再度ログインしてからもう一度お試しください。`;
}

/**
 * ラベルのロールバック（updateIssueの再実行）自体も失敗した場合の案内。手動確認を促す。
 */
export function withRollbackFailureNotice(baseMessage: string): string {
  return `${baseMessage} ラベルの復元にも失敗しました。手動でご確認ください。`;
}
