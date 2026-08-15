import { isApprovalPending, isManualStepIssue, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
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

/** 実装着手前に見た目のアーティファクト（自己完結HTML）を公開させるラベル（#1473・#1540） */
export const ARTIFACT_REQUIRED_LABEL = "25.artifact-required";

/** developへのマージ前に必ずユーザー確認を必須にするラベル */
export const MERGE_CONFIRM_REQUIRED_LABEL = "22.merge-confirm-required";

export type StartImplementationOptionKey =
  | "planRequired"
  | "previewRequired"
  | "screenshotRequired"
  | "artifactRequired"
  | "mergeConfirmRequired";

export type StartImplementationOptions = Record<StartImplementationOptionKey, boolean>;

export const START_IMPLEMENTATION_DEFAULT_OPTIONS: StartImplementationOptions = {
  planRequired: false,
  previewRequired: false,
  screenshotRequired: false,
  artifactRequired: false,
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
    description:
      "実装前にPlan modeで計画を提示し、承認を得てから実装を進めます（新機能・改善のIssueでは既定でON）",
    githubLabel: PLAN_REQUIRED_LABEL,
  },
  {
    key: "mergeConfirmRequired",
    label: "マージ前に確認が必要",
    description:
      "内容によらず、developへのマージ前に必ず自分で差分を確認します（認証・DB・本番設定・Actions・Secrets・課金の変更は指定しなくても自動で止まります）",
    githubLabel: MERGE_CONFIRM_REQUIRED_LABEL,
  },
  {
    key: "previewRequired",
    label: "開発環境を起動する",
    description:
      "PR作成前に開発サーバーを起動し、画面を確認してもらってから実装を進めます（サブPC実行ならtailnet経由でスマホからも開けます）",
    githubLabel: PREVIEW_REQUIRED_LABEL,
  },
  {
    key: "screenshotRequired",
    label: "スクリーンショットが必要",
    description:
      "PR作成前に変更箇所のスクリーンショットを取得し、Issueへ貼ります（無人実行は終了と同時にdevサーバーが消えるため、画面を見る唯一の手段）",
    githubLabel: SCREENSHOT_REQUIRED_LABEL,
  },
  {
    key: "artifactRequired",
    label: "アーティファクトで見た目を出す",
    description:
      "コードを書き始める前に見た目を自己完結HTMLのアーティファクトとして公開し、承認を得てから実装に入ります（実物ではなく実装前の見た目案です。「計画が必要」と併用すると計画と一緒に承認できます）",
    githubLabel: ARTIFACT_REQUIRED_LABEL,
  },
];

/**
 * 計画フェーズを既定でONにするIssue種別ラベル（#1317）。
 *
 * **「何をどう作るか」に選択の余地がある種別だけを挙げる。** バグ修正・軽微な修正・文書整理は
 * 直すべき箇所が決まっており、計画を挟んでも承認待ちの往復が増えるだけで判断が変わらない。
 * ここに無い種別（未選択も含む）は従来どおり既定でOFFになる。
 */
export const PLAN_REQUIRED_DEFAULT_TYPE_LABELS = ["50.feature", "51.improvement", "62.design"];

/**
 * Issueの種別ラベルから「計画が必要」の既定値を求める（#1317）。
 *
 * **見るのは種別ラベルだけで、`21.plan-required`自体の有無は見ない。** 種別を選び直したときに
 * 既定を付け外しの両方向へ追従させるため（Issue作成画面）。既に付いているラベルを尊重するかどうかは
 * 呼び出し側で判断する。どちらの画面でも、ユーザーが自分でチェックを触った後は上書きしない。
 */
export function planRequiredDefaultForLabels(labelNames: readonly string[]): boolean {
  return labelNames.some((name) => PLAN_REQUIRED_DEFAULT_TYPE_LABELS.includes(name));
}

/**
 * 実行先に応じて、ダイアログに出すオプションを絞る（#1317）。
 *
 * **スクリーンショットはGitHub Actions（無人実行）のときだけ出す。** サブPC実行・ローカル実行では
 * `tailscale serve`で開発サーバーそのものをtailnetへ出せる（#1265）ため、スマホからでも実物の画面を
 * 確認でき、撮影は重いだけで得るものが無い。無人実行はワークフロー終了と同時にdevサーバーが消え、
 * Fly.ioのプレビュー環境も#1308で廃止したため、撮影が画面を見る唯一の手段として残る。
 *
 * **アーティファクトは逆に、GitHub Actions（無人実行）のときだけ隠す**（#1473）。
 * アーティファクトの公開はローカルセッションのツールで、無人実行からは作れない。
 *
 * **既にチェックが入っている場合は実行先によらず出す。** 隠すと、付いてしまったラベルを
 * このダイアログから外せなくなる（`resolveScreenshotRejection`で無効化する側と同じ考え方）。
 */
export function visibleStartImplementationOptions({
  isActionsTarget,
  options,
}: {
  isActionsTarget: boolean;
  options: StartImplementationOptions;
}): typeof START_IMPLEMENTATION_OPTIONS {
  return START_IMPLEMENTATION_OPTIONS.filter((option) => {
    if (option.key === "screenshotRequired") {
      return isActionsTarget || options.screenshotRequired;
    }
    if (option.key === "artifactRequired") {
      return !isActionsTarget || options.artifactRequired;
    }
    return true;
  });
}

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
 *
 * **進捗（`Planning`/`Implementation`）はラベルではなくProject Statusで表す**（#991 Phase 5）。
 * ここで返すのは実装オプション用ラベルだけで、着手状態は呼び出し側が続けて行う
 * 進捗の書き込み（`setProgressStatus`）が担う。
 */
export function startImplementationLabelsToAdd(options: StartImplementationOptions): string[] {
  return START_IMPLEMENTATION_OPTIONS.filter((option) => options[option.key]).map(
    (option) => option.githubLabel,
  );
}

/**
 * issueに既に付与されているラベルから、対応するオプションの初期選択状態を求める。
 *
 * 「計画が必要」だけは種別ラベルからの既定（#1317）も見る。`21.plan-required`が付いていなくても、
 * 新機能・改善のIssueではチェックが入った状態で開く。
 */
export function startImplementationOptionsFromLabels(labels: IssueLabel[]): StartImplementationOptions {
  const labelNames = labels.map((label) => label.name);
  const attached = new Set(labelNames);
  return START_IMPLEMENTATION_OPTIONS.reduce((options, option) => {
    options[option.key] =
      option.key === "planRequired"
        ? attached.has(PLAN_REQUIRED_LABEL) || planRequiredDefaultForLabels(labelNames)
        : attached.has(option.githubLabel);
    return options;
  }, {} as StartImplementationOptions);
}

/**
 * 未着手（進捗が`Ready`で、承認待ちでもない）openなissueでのみ
 * 「実装を開始」ボタンを表示する。着手済みissueでは通常のコメント欄から
 * 追加対応(additional)を依頼できるため、このボタンは初回起動専用。
 *
 * **手作業Issue（`71.manual-step`）では出さない（#1280）。** 手作業Issueは定義上
 * エージェントが代行できない作業で、進捗も`Ready`のまま留まるため、この条件だけでは
 * 「まだ誰も着手していないIssue」と区別が付かず、実装エージェントへ送る導線が
 * 主ボタンとして出てしまう。押しても実装対象が無く、`Implementation`へ進んだ結果
 * 「手作業待ち」ビューでの見え方も壊れる。手作業Issueの出口は
 * `canCompleteManualStep`側の「手作業を完了してクローズ」。
 */
export function canStartImplementation(
  issue: Pick<Issue, "state" | "labels" | "projectStatus">,
): boolean {
  return (
    issue.state === "open" &&
    getWorkflowStepIndex(issue) === null &&
    !isApprovalPending(issue.labels) &&
    !isManualStepIssue(issue.labels)
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
