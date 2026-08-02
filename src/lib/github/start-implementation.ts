import { isApprovalPending, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

/** 「実装を開始」ボタン押下時に投稿する定型コメント本文（claude-issue-dispatch.ymlの@claudeトリガーに反応する） */
export const START_IMPLEMENTATION_COMMENT_BODY = "@claude 実装を開始してください";

/** 実装前にPlan modeでの計画提示・承認を必須にするラベル */
export const PREVIEW_REQUIRED_LABEL = "22.preview-required";

/** PR作成前に開発サーバーを起動し画面確認・承認を必須にするラベル */
export const SCREENSHOT_REQUIRED_LABEL = "23.screenshot-required";

export type StartImplementationOptionKey = "planRequired" | "previewRequired" | "screenshotRequired";

export type StartImplementationOptions = Record<StartImplementationOptionKey, boolean>;

export const START_IMPLEMENTATION_DEFAULT_OPTIONS: StartImplementationOptions = {
  planRequired: false,
  previewRequired: false,
  screenshotRequired: false,
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

/** 選択されたオプションに対応するGitHubラベル名の配列を返す */
export function startImplementationLabelsToAdd(options: StartImplementationOptions): string[] {
  return START_IMPLEMENTATION_OPTIONS.filter((option) => options[option.key]).map(
    (option) => option.githubLabel,
  );
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
