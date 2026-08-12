import { type LucideIcon } from "lucide-react";

import {
  ADVANCED_PROGRESS_STATUSES,
  getProgressStatusIndex,
  hasActiveProgress,
  resolveProgressStatus,
  type ProgressSource,
  type ProgressStatusKey,
} from "@/lib/issue-progress";
import type { Issue } from "@/types/issue";

export type WorkflowStep = {
  /** 対応する進捗状態のキー */
  key: ProgressStatusKey;
  /** GitHub Projects v2 の Status 名。ツールチップに出して盤面の列名と対応づける */
  projectStatus: string;
  /** ステップ表示用の短い日本語ラベル */
  label: string;
  /** ステップ表示用のアイコン（円の中身。未完了・現在ステップ時のみ使う。完了済みはCheckで統一） */
  icon: LucideIcon;
  /**
   * この段階でGitHub Actions（実装・レビューエージェント）の実行が進行し得るかどうか。
   * `develop`（developマージ完了）・`done`（mainマージ完了）はマージ後の定常状態で
   * 実行は走らないため、一覧の実行状況ポーリング対象から外してGitHub APIの消費を抑える。
   */
  active: boolean;
};

/**
 * マルチエージェント運用における実装状況ステップ（Planning〜Done）の遷移順。
 *
 * 定義の実体は[issue-progress.ts](../issue-progress.ts)の`PROGRESS_STATUSES`にあり、ここでは
 * ステップ表示用に「未着手を除く6状態」だけを取り出している。未着手（`ready`）を
 * 含めないのは、進捗が動いていないissueではステップ表示自体を出さない仕様のため
 * （`getWorkflowStepIndex`がnullを返す）。
 */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = ADVANCED_PROGRESS_STATUSES.map((status) => ({
  key: status.key,
  projectStatus: status.projectStatus,
  label: status.label,
  icon: status.icon,
  active: status.active,
}));

/**
 * issueのワークフロー上の現在ステップのindexを返す。未着手ならnull。
 *
 * 判定は[issue-progress.ts](../issue-progress.ts)の`resolveProgressStatus`に委ねており、
 * **Project Statusだけを見る**（進捗ラベルは #991 Phase 5 で廃止済み）。
 */
export function getWorkflowStepIndex(issue: ProgressSource): number | null {
  const status = resolveProgressStatus(issue);
  if (status === "ready") return null;
  const index = WORKFLOW_STEPS.findIndex((step) => step.key === status);
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
  issue: Pick<Issue, "state" | "projectStatus">,
): boolean {
  if (issue.state === "closed") return true;
  const status = resolveProgressStatus(issue);
  if (status === "ready") return false;
  return getProgressStatusIndex(status) >= getProgressStatusIndex("develop");
}
