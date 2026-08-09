import { isApprovalPending, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  getWorkflowStepIndex,
  PLANNING_LABEL_NAME,
  WIP_LABEL_NAME,
} from "@/lib/github/workflow-status";
import { isProgressLabel } from "@/lib/issue-status";
import type { Issue, IssueLabel } from "@/types/issue";

/**
 * 「実装を開始」ボタン押下時に投稿する定型コメント本文（claude-issue-dispatch.ymlの@claudeトリガーに反応する）。
 * 「計画が必要」選択時は実際には計画提示までしか行われないため、文言を「実装を開始」ではなく
 * 「計画を立案」にする（approveCommentBodyのisPlanApprovalPendingと同じ出し分けパターン）。
 */
export function startImplementationCommentBody(planRequired: boolean): string {
  return planRequired ? "@claude 計画を立案してください" : "@claude 実装を開始してください";
}

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

/** 実装オプション用チェックボックスと表示が重複しないよう、ラベル選択欄から除外するラベル名 */
const START_IMPLEMENTATION_OPTION_LABEL_NAMES = new Set(
  START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel),
);

/**
 * 進捗管理用ラベル・実装オプション用ラベルを除いた、ユーザーが選択可能なラベルかどうか。
 * 「新しいIssueを作成」「リポジトリに質問する」の両ラベル選択欄で共通して使う（#887）。
 */
export function isSelectableLabelName(name: string): boolean {
  return !isProgressLabel(name) && !START_IMPLEMENTATION_OPTION_LABEL_NAMES.has(name);
}

/**
 * 選択されたオプションに対応するGitHubラベル名の配列を返す。
 * ワークフロー起動を待たずにUI上で即座に着手状態を示せるよう、進捗状況ラベルを必ず含める。
 * 「計画が必要」選択時は計画検討中を示す01.planningのみを付与し、実装着手（02.wip）は
 * claude-issue-dispatch.yml側が計画承認後に付与する。未選択時は計画フェーズを経ないため
 * 最初から02.wipを付与する。
 */
export function startImplementationLabelsToAdd(options: StartImplementationOptions): string[] {
  return [
    options.planRequired ? PLANNING_LABEL_NAME : WIP_LABEL_NAME,
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
 * 「作成＋実装開始」時に、Issue作成と同時に付与すべきラベル一覧を返す。
 * オプション選択画面（実装オプション用チェックボックス）は既にIssue作成画面と共通のため、
 * 選択済みラベルにはオプションの実装オプション用ラベルが含まれている。ここではそれに加えて、
 * 「計画が必要」の選択有無に応じた進捗状況ラベル（01.planning/02.wip）を付与する。
 */
export function startImplementationLabelsForCreate(selectedLabels: string[]): string[] {
  const progressLabel = selectedLabels.includes(PLAN_REQUIRED_LABEL)
    ? PLANNING_LABEL_NAME
    : WIP_LABEL_NAME;
  return [...new Set([...selectedLabels, progressLabel])];
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

/**
 * リポジトリにissue-deckの自動化ワークフロー（claude-issue-dispatch.yml）が見つからない場合、
 * 「実装を開始」ボタンを押しても`@claude`コメントに反応するワークフローが存在せず何も起動しない。
 * ボタン自体は非表示にせず、押せない理由を示した上で無効化する（#976）。
 * `hasClaudeWorkflow`が明示的にfalseの場合のみ無効化し、リポジトリ情報が見つからない等でundefinedの
 * 場合は誤って無効化しないよう理由を返さない。
 * 文言・判定はリポジトリ一覧のバッジ（sidebar-nav.tsx・mobile-repos-screen.tsx）と揃えている。
 */
export function startImplementationDisabledReason(hasClaudeWorkflow: boolean | undefined): string | null {
  if (hasClaudeWorkflow === false) {
    return "issue-deckの自動化workflow（claude-issue-dispatch.yml）が見つかりません（対応可否の近似判定です）。実装を開始しても起動しません。";
  }
  return null;
}
