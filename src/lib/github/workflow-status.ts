import { type LucideIcon } from "lucide-react";

import {
  LABELED_PROGRESS_STATUSES,
  getProgressStatusDef,
  hasActiveProgress,
  resolveProgressStatus,
  type ProgressSource,
} from "@/lib/issue-progress";
import type { Issue } from "@/types/issue";

export type WorkflowStep = {
  /** 対応するGitHubラベル名 */
  labelName: string;
  /** ステップ表示用の短い日本語ラベル */
  label: string;
  /** ステップ表示用のアイコン（円の中身。未完了・現在ステップ時のみ使う。完了済みはCheckで統一） */
  icon: LucideIcon;
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

/**
 * マルチエージェント運用における実装状況ステップ（01.planning〜09.main）の遷移順。
 *
 * 定義の実体は[issue-progress.ts](../issue-progress.ts)の`PROGRESS_STATUSES`にあり、ここでは
 * ステップ表示用に「進捗ラベルを持つ6状態」だけを取り出している。未着手（`ready`）を
 * 含めないのは、進捗が動いていないissueではステップ表示自体を出さない仕様のため
 * （`getWorkflowStepIndex`がnullを返す）。
 */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = LABELED_PROGRESS_STATUSES.map((status) => ({
  labelName: status.labelName,
  label: status.label,
  icon: status.icon,
  active: status.active,
}));

/**
 * issueのワークフロー上の現在ステップのindexを返す。未着手ならnull。
 *
 * 判定は[issue-progress.ts](../issue-progress.ts)の`resolveProgressStatus`に委ねており、
 * **Project Statusがあればそれを優先し、無ければ進捗ラベルへフォールバックする**。
 */
export function getWorkflowStepIndex(issue: ProgressSource): number | null {
  const status = resolveProgressStatus(issue);
  if (status === "ready") return null;
  const labelName = getProgressStatusDef(status).labelName;
  const index = WORKFLOW_STEPS.findIndex((step) => step.labelName === labelName);
  return index === -1 ? null : index;
}

/**
 * GitHub Actionsの実行が進行し得る段階かどうか。実行状況のポーリング対象を絞り込むのに使う。
 * 判定の詳細は`hasActiveProgress`を参照。
 */
export function hasActiveWorkflowStep(issue: ProgressSource): boolean {
  return hasActiveProgress(issue);
}

/**
 * コメント欄の「引き継いでIssueを作成」ボタンを表示すべきかどうか。
 * このissueで直接修正を続けるのが難しい（developへのPRがマージ済み、またはissueがclosed）
 * 場合にのみ表示し、まだ同じブランチで修正できる段階では非表示にする（#452）。
 */
export function canCreateFollowupFromComment(
  issue: Pick<Issue, "state" | "labels" | "projectStatus">,
): boolean {
  if (issue.state === "closed") return true;
  const index = getWorkflowStepIndex(issue);
  if (index === null) return false;
  const developMergedIndex = WORKFLOW_STEPS.findIndex(
    (step) => step.labelName === DEVELOP_MERGED_LABEL_NAME,
  );
  return index >= developMergedIndex;
}
