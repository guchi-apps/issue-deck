import type { Issue, IssueLabel } from "@/types/issue";

export type WorkflowStep = {
  /** 対応するGitHubラベル名 */
  labelName: string;
  /** ステップ表示用の短い日本語ラベル */
  label: string;
  /**
   * この段階でGitHub Actions（実装・レビューエージェント）の実行が進行し得るかどうか。
   * `05.develop`（developマージ完了）・`09.main`（mainマージ完了）はマージ後の定常状態で
   * 実行は走らないため、一覧の実行状況ポーリング対象から外してGitHub APIの消費を抑える。
   */
  active: boolean;
};

/** 実装前の計画検討中のIssueに付与されるラベル名（21.plan-required選択時のみ経由する） */
export const PLANNING_LABEL_NAME = "01.planning";

/** 実装中のIssueに付与されるラベル名 */
export const WIP_LABEL_NAME = "02.wip";

/** developへマージ済み・main未反映のIssueに付与されるラベル名。リリース確認ダイアログでの対象Issue抽出にも使う */
export const DEVELOP_MERGED_LABEL_NAME = "05.develop";

/** mainへ反映済みのIssueに付与されるラベル名 */
export const MAIN_MERGED_LABEL_NAME = "09.main";

/** マルチエージェント運用における実装状況ラベル（01.planning〜09.main）の遷移順（CLAUDE.md参照） */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  { labelName: PLANNING_LABEL_NAME, label: "計画検討中", active: true },
  { labelName: WIP_LABEL_NAME, label: "実装中", active: true },
  { labelName: "03.d:marge", label: "developへマージ", active: true },
  { labelName: DEVELOP_MERGED_LABEL_NAME, label: "develop反映済", active: false },
  { labelName: "07.m:marge", label: "本番へマージ", active: true },
  { labelName: MAIN_MERGED_LABEL_NAME, label: "本番反映済", active: false },
];

/** issueのラベルからワークフロー上の現在ステップのindexを返す。該当ラベルがなければnull */
export function getWorkflowStepIndex(labels: IssueLabel[]): number | null {
  const names = new Set(labels.map((label) => label.name));
  const index = WORKFLOW_STEPS.findIndex((step) => names.has(step.labelName));
  return index === -1 ? null : index;
}

/**
 * GitHub Actionsの実行が進行し得る段階のラベル（01.planning / 02.wip / 03.d:marge / 07.m:marge）が
 * 付いているかどうか。実行状況のポーリング対象を絞り込むのに使う。
 * 遷移の過渡期に新旧のラベルが同時に付くことがあるため、現在ステップ（先頭一致）ではなく
 * 「進行し得るラベルがひとつでも付いているか」で判定する。
 */
export function hasActiveWorkflowStep(labels: IssueLabel[]): boolean {
  const names = new Set(labels.map((label) => label.name));
  return WORKFLOW_STEPS.some((step) => step.active && names.has(step.labelName));
}

/**
 * コメント欄の「引き継いでIssueを作成」ボタンを表示すべきかどうか。
 * このissueで直接修正を続けるのが難しい（developへのPRがマージ済み、またはissueがclosed）
 * 場合にのみ表示し、まだ同じブランチで修正できる段階では非表示にする（#452）。
 */
export function canCreateFollowupFromComment(issue: Pick<Issue, "state" | "labels">): boolean {
  if (issue.state === "closed") return true;
  const index = getWorkflowStepIndex(issue.labels);
  if (index === null) return false;
  const developMergedIndex = WORKFLOW_STEPS.findIndex(
    (step) => step.labelName === DEVELOP_MERGED_LABEL_NAME,
  );
  return index >= developMergedIndex;
}
