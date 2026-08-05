import type { IssueLabel } from "@/types/issue";

export type WorkflowStep = {
  /** 対応するGitHubラベル名 */
  labelName: string;
  /** ステップ表示用の短い日本語ラベル */
  label: string;
};

/** developへマージ済み・main未反映のIssueに付与されるラベル名。リリース確認ダイアログでの対象Issue抽出にも使う */
export const DEVELOP_MERGED_LABEL_NAME = "05.develop";

/** マルチエージェント運用における実装状況ラベル（01.wip〜09.main）の遷移順（CLAUDE.md参照） */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  { labelName: "01.wip", label: "実装中" },
  { labelName: "03.d:marge", label: "developへPR" },
  { labelName: DEVELOP_MERGED_LABEL_NAME, label: "develop済" },
  { labelName: "07.m:marge", label: "mainへPR" },
  { labelName: "09.main", label: "main済" },
];

/** issueのラベルからワークフロー上の現在ステップのindexを返す。該当ラベルがなければnull */
export function getWorkflowStepIndex(labels: IssueLabel[]): number | null {
  const names = new Set(labels.map((label) => label.name));
  const index = WORKFLOW_STEPS.findIndex((step) => names.has(step.labelName));
  return index === -1 ? null : index;
}
