import { isApprovalPending, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import type { Issue, IssueLabel } from "@/types/issue";

/** 「実装を開始」ボタン押下時に投稿する定型コメント本文（claude-issue-dispatch.ymlの@claudeトリガーに反応する） */
export const START_IMPLEMENTATION_COMMENT_BODY = "@claude 実装を開始してください";

/** 実装前にPlan modeでの計画提示・承認を必須にするラベル */
export const PREVIEW_REQUIRED_LABEL = "23.preview-required";

/** PR作成前に開発サーバーを起動し画面確認・承認を必須にするラベル */
export const SCREENSHOT_REQUIRED_LABEL = "24.screenshot-required";

/** developへのマージ前に必ずユーザー確認を必須にするラベル */
export const MERGE_CONFIRM_REQUIRED_LABEL = "22.merge-confirm-required";

export type StartImplementationOptionKey =
  | "planRequired"
  | "previewRequired"
  | "screenshotRequired"
  | "mergeConfirmRequired";

export type StartImplementationOptions = Record<StartImplementationOptionKey, boolean>;

export const START_IMPLEMENTATION_DEFAULT_OPTIONS: StartImplementationOptions = {
  planRequired: false,
  previewRequired: false,
  screenshotRequired: false,
  mergeConfirmRequired: false,
};

/** 「実装を開始」ダイアログで選択できるオプションの定義（表示順） */
export const START_IMPLEMENTATION_OPTIONS: {
  key: StartImplementationOptionKey;
  label: string;
  description: string;
  githubLabel: string;
}[] = [
  {
    key: "planRequired",
    label: "計画が必要",
    description: "実装前にPlan modeで計画を提示し、承認を得てから実装を進めます",
    githubLabel: PLAN_REQUIRED_LABEL,
  },
  {
    key: "mergeConfirmRequired",
    label: "マージ前に確認が必要",
    description: "developへのマージ前に必ずユーザーの確認を挟んでから進めます",
    githubLabel: MERGE_CONFIRM_REQUIRED_LABEL,
  },
  {
    key: "previewRequired",
    label: "開発環境を起動する",
    description: "PR作成前に開発サーバーを起動し、画面を確認してもらってから実装を進めます",
    githubLabel: PREVIEW_REQUIRED_LABEL,
  },
  {
    key: "screenshotRequired",
    label: "スクリーンショットが必要",
    description: "PR作成前に変更箇所のスクリーンショットを取得し、確認してもらってから実装を進めます",
    githubLabel: SCREENSHOT_REQUIRED_LABEL,
  },
];

/**
 * 選択されたオプションに対応するGitHubラベル名の配列を返す。
 * ワークフロー起動を待たずにUI上で即座に着手状態を示せるよう、
 * オプションの選択有無に関わらず常に01.wip（実装中）を含む。
 */
export function startImplementationLabelsToAdd(options: StartImplementationOptions): string[] {
  return [
    WORKFLOW_STEPS[0].labelName,
    ...START_IMPLEMENTATION_OPTIONS.filter((option) => options[option.key]).map(
      (option) => option.githubLabel,
    ),
  ];
}

/** issueに既に付与されているラベルから、対応するオプションの初期選択状態を求める */
export function startImplementationOptionsFromLabels(labels: IssueLabel[]): StartImplementationOptions {
  const labelNames = new Set(labels.map((label) => label.name));
  return START_IMPLEMENTATION_OPTIONS.reduce((options, option) => {
    options[option.key] = labelNames.has(option.githubLabel);
    return options;
  }, {} as StartImplementationOptions);
}

/**
 * 未着手（実装状況ラベルが無く、承認待ちでもない）openなissueでのみ
 * 「実装を開始」ボタンを表示する。着手済みissueでは通常のコメント欄から
 * 追加対応(additional)を依頼できるため、このボタンは初回起動専用。
 */
export function canStartImplementation(issue: Pick<Issue, "state" | "labels">): boolean {
  return (
    issue.state === "open" &&
    getWorkflowStepIndex(issue.labels) === null &&
    !isApprovalPending(issue.labels)
  );
}
