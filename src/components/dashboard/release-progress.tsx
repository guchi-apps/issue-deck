"use client";

import { Check, CircleAlert, Clock, ExternalLink, GitPullRequest, Loader2 } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { parseGithubReferenceUrl } from "@/lib/github-reference";
import { repairKindsFor, type RepairKind } from "@/lib/github/pull-request-repair";
import { cn } from "@/lib/utils";
import type { CiState, ReleaseStatus, ReleaseWorkflowRun } from "@/hooks/use-release-status";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

/**
 * リンク先がどこかを示すアイコン。リリース進捗のリンクにはPR（アプリ内で開く）と
 * GitHub Actionsの実行ログ（アプリ内に対応する画面が無く別タブで開く）が混在するため、
 * 行き先を取り違えないよう出し分ける（#1260）。
 */
function LinkDestinationIcon({ href }: { href: string }) {
  return parseGithubReferenceUrl(href) ? (
    <GitPullRequest className="size-3.5" />
  ) : (
    <ExternalLink className="size-3.5" />
  );
}

/**
 * 「本番デプロイ」段がstate: "done"（デプロイ成功）で表示される条件と同じかどうかを判定する。
 * デプロイ後の反映確認チェックリスト（#534）の表示条件に使う。
 */
export function isProductionDeployComplete(status: AvailableReleaseStatus): boolean {
  const runActive = status.workflowRun != null && status.workflowRun.status !== "completed";
  if (status.phase !== "none" || runActive) return false;
  const deployRun = status.deployWorkflowRun;
  return deployRun?.status === "completed" && deployRun.conclusion === "success";
}

type StepState =
  | "done" // 完了
  | "active" // 進行中（自動で進む。人の操作は不要）
  | "action" // 要操作（人がマージする。マージ用URLを添付する）
  | "error" // 失敗（デプロイ失敗など。人が内容を確認する）
  | "todo"; // 未着手（待ち）

type Step = {
  label: string;
  state: StepState;
  /** 補足文（次に起きることの説明など。CI状態はciStateのバッジで表す） */
  note?: string;
  /** noteより長い補足文（バージョンバンプの判断根拠など、複数行になりうるもの） */
  detail?: string;
  /** バンプPR本文の「## 更新履歴（生成された利用者向け文言）」セクションから抜き出した更新履歴 */
  changelog?: string;
  /** マージ待ちPRの最新コミットのCI状態。バッジとして表示する */
  ciState?: CiState | null;
  /** マージ待ちPRがbaseとコンフリクトしているか。判定中・取得できない場合はnull */
  mergeable?: boolean | null;
  /**
   * この段のマージ待ちPRを直すボタンの対象（#1293）。CI失敗・コンフリクトで止まっている段に、
   * その場で自動修復を起動する導線を添えるために持つ。
   */
  repair?: { pullRequestNumber: number; kinds: RepairKind[] };
  /** 要操作・要確認段で表示するリンク（マージ用URL、デプロイ失敗時のrun URLなど） */
  action?: { href: string; label: string };
  /** 参考リンク（要操作ではない。実行中・完了段でrun詳細への導線として添える） */
  link?: { href: string; label: string; pending?: boolean };
};

const CI_STATE_LABEL: Record<CiState, string> = {
  pending: "CI実行中",
  success: "CI通過",
  failure: "CI失敗",
  unknown: "CI状態は不明",
};

/**
 * マージ待ちPRの最新コミットのCI状態を色付きピルで表示する。`pull-request-ci-status.tsx`の
 * 配色方針（primary/destructive/mutedのring付きピル）を踏襲しつつ、型はCiState用に独立させている。
 */
function CiStateBadge({ ciState }: { ciState: CiState | null | undefined }) {
  if (!ciState) return null;

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        ciState === "pending"
          ? "bg-primary/15 text-primary ring-primary"
          : ciState === "failure"
            ? "bg-destructive/15 text-destructive ring-destructive"
            : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {CI_STATE_LABEL[ciState]}
    </span>
  );
}

/**
 * マージ待ちPRがbaseとコンフリクトしていることを示すピル。CI状態と同じ並びに出す。
 */
function ConflictBadge({ mergeable }: { mergeable: boolean | null | undefined }) {
  if (mergeable !== false) return null;

  return (
    <span className="inline-flex w-fit items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
      コンフリクトあり
    </span>
  );
}

/**
 * 段に紐づくマージ待ちPRから、自動修復ボタンの対象を組み立てる（#1293）。
 * 出す種類が無ければ`undefined`を返し、段に何も添えない。
 */
function repairForPullRequest(pullRequest: {
  number: number;
  ciState: CiState | null;
  mergeable: boolean | null;
}): Step["repair"] {
  const kinds = repairKindsFor(
    { state: "open", draft: false, ciState: pullRequest.ciState },
    pullRequest.mergeable,
  );
  return kinds.length > 0 ? { pullRequestNumber: pullRequest.number, kinds } : undefined;
}

/**
 * リリースの論理段階（4ステップ）を、版数・オープン中PR・実行中runから組み立てる。
 * 人の操作（マージ）が必要な段には、その場でマージできるPRのURLを`action`として添える。
 * mainの本番デプロイ（deploy.yml）のrunが取得できれば、5段目として末尾に追加する。ただし
 * phaseが"none"（今回の一連の反映が完了、または対象なし）かつワークフロー実行中でない場合
 * のみ追加する。バンプPR作成〜mainへマージが進行中の間にdeploy.ymlの最新runを出すと、まだ
 * 今回のmainへのマージが完了していないにもかかわらず前回リリース時のデプロイ成功が残り
 * 続けて見えてしまうため(#470)。バンプPRがまだ現れていない起動直後（phaseは"none"のまま）も
 * ワークフロー実行中である以上は同様に隠す必要がある(#545)。
 *
 * `workflowRun`（`release-develop-to-main.yml`自体の最新実行）が失敗している場合、進行中の
 * はずの段が実際には止まっていることを明示するため、該当段を"error"にしてrunへのリンクを
 * 添える（それまでは`phase`が変わらないまま"PR作成中"等の表示が残り続け、失敗に気づきにくかった。#727）。
 */
function buildSteps(status: AvailableReleaseStatus): Step[] {
  const { phase, bumpPullRequest: bump, releasePullRequest: release, workflowRun, developVersion } = status;
  const runActive = workflowRun != null && workflowRun.status !== "completed";
  const failedRun =
    workflowRun && workflowRun.status === "completed" && workflowRun.conclusion !== "success" ? workflowRun : null;

  const steps: Step[] = [
    { label: "バンプPR作成", state: "todo" },
    { label: "develop反映（バンプPRのマージ）", state: "todo" },
    { label: "develop→main PR作成", state: "todo" },
    { label: "mainへマージ", state: "todo" },
  ];

  if (phase === "bump_pr_open" && bump) {
    steps[0].state = "done";
    steps[0].note = bump.version ? `次バージョン: v${bump.version}` : undefined;
    steps[0].detail = bump.reason ?? undefined;
    steps[0].changelog = bump.changelog ?? undefined;
    // CIが実行中の間は自動マージ待ちの「進行中」、それ以外はスマホから1タップでマージできる「要操作」。
    const waitingCi = bump.ciState === "pending";
    steps[1].state = waitingCi ? "active" : "action";
    steps[1].ciState = bump.ciState;
    steps[1].mergeable = bump.mergeable;
    steps[1].repair = repairForPullRequest(bump);
    if (!waitingCi) {
      steps[1].action = {
        href: bump.url,
        label: `バンプPR #${bump.number} をタップしてマージ`,
      };
    }
  } else if (phase === "release_pending") {
    steps[0].state = "done";
    steps[0].note = developVersion ? `次バージョン: v${developVersion}` : undefined;
    steps[1].state = "done";
    if (failedRun) {
      steps[2].state = "error";
      steps[2].note = "develop→main PRの自動作成に失敗しました";
      steps[2].action = { href: failedRun.htmlUrl, label: "GitHub Actionsで確認して対処" };
    } else {
      steps[2].state = "active";
      steps[2].note = "PR作成中";
    }
  } else if (phase === "release_pr_open" && release) {
    steps[0].state = "done";
    steps[0].note = developVersion ? `次バージョン: v${developVersion}` : undefined;
    steps[1].state = "done";
    steps[2].state = "done";
    steps[3].state = "action";
    steps[3].ciState = release.ciState;
    steps[3].mergeable = release.mergeable;
    steps[3].repair = repairForPullRequest(release);
    steps[3].note = "内容を確認して「merge commit」でマージしてください。";
    steps[3].action = {
      href: release.url,
      label: `develop→main PR #${release.number} をタップしてmainへマージ`,
    };
  } else if (runActive) {
    // まだPRが現れていないが実行中（起動直後）。最初の段を進行中にする。
    steps[0].state = "active";
    steps[0].note = "ワークフロー実行中...";
  } else if (failedRun && phase === "none") {
    // バージョン判定・バンプPR作成のいずれかで失敗し、PRが1つも作られなかったケース。
    steps[0].state = "error";
    steps[0].note = "バージョン判定・バンプPR作成に失敗しました";
    steps[0].action = { href: failedRun.htmlUrl, label: "GitHub Actionsで確認して対処" };
  }

  if (phase === "none" && !runActive) {
    const deployStep = buildDeployStep(status.deployWorkflowRun);
    if (deployStep) steps.push(deployStep);
  }

  return steps;
}

/**
 * mainブランチの現在のHEADに対するdeploy.ymlの最新runから「本番デプロイ」段を組み立てる。
 * mainへマージした後、実際に本番デプロイまで成功したかを見届けられるようにする段(#392)。
 * runが1件も取得できない（workflowが存在しない等）場合は段自体を出さない。
 */
function buildDeployStep(deployRun: ReleaseWorkflowRun | null): Step | null {
  if (!deployRun) return null;

  if (deployRun.status !== "completed") {
    return {
      label: "本番デプロイ",
      state: "active",
      note: "デプロイ実行中",
      link: { href: deployRun.htmlUrl, label: "GitHub Actionsで確認", pending: true },
    };
  }

  if (deployRun.conclusion === "success") {
    return {
      label: "本番デプロイ",
      state: "done",
      note: "デプロイ成功",
      link: { href: deployRun.htmlUrl, label: "GitHub Actionsで確認" },
    };
  }

  return {
    label: "本番デプロイ",
    state: "error",
    note: `デプロイに失敗しました（${deployRun.conclusion ?? deployRun.status}）`,
    action: { href: deployRun.htmlUrl, label: "GitHub Actionsで確認して対処" },
  };
}

function StepIcon({ state, compact }: { state: StepState; compact: boolean }) {
  const size = compact ? "size-3.5" : "size-4";
  switch (state) {
    case "done":
      return <Check className={cn(size, "text-green-600 dark:text-green-500")} />;
    case "active":
      return <Loader2 className={cn(size, "animate-spin text-primary")} />;
    case "action":
      return <CircleAlert className={cn(size, "text-amber-600 dark:text-amber-500")} />;
    case "error":
      return <CircleAlert className={cn(size, "text-red-600 dark:text-red-500")} />;
    default:
      return <Clock className={cn(size, "text-muted-foreground/60")} />;
  }
}

export function ReleaseProgress({
  status,
  compact = false,
  repoFullName = null,
}: {
  status: AvailableReleaseStatus;
  compact?: boolean;
  /**
   * 表示中のリリース対象リポジトリ（`owner/repo`）。自動修復ボタンの起動先を決めるのに使う。
   * 渡さない場合はボタンを出さない（進捗表示そのものはリポジトリ名なしでも成立するため）。
   */
  repoFullName?: string | null;
}) {
  const steps = buildSteps(status);
  const { workflowRun } = status;
  const text = compact ? "text-xs" : "text-sm";
  const nothingToDo = status.phase === "none" && !(workflowRun && workflowRun.status !== "completed");

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, i) => (
          <li key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <StepIcon state={step.state} compact={compact} />
              <span
                className={cn(
                  text,
                  step.state === "todo" && "text-muted-foreground",
                  step.state === "action" && "font-medium text-amber-700 dark:text-amber-400",
                  step.state === "error" && "font-medium text-red-700 dark:text-red-400",
                )}
              >
                {step.label}
              </span>
              <CiStateBadge ciState={step.ciState} />
              <ConflictBadge mergeable={step.mergeable} />
              {step.note && step.state !== "action" && (
                <span className={cn("text-xs text-muted-foreground")}>{step.note}</span>
              )}
            </div>
            {/* CI失敗・コンフリクトで止まっている段には、その場で自動修復を起動する
                ボタンを添える（#1293）。本番へのリリースPRもここに現れる。 */}
            {step.repair && repoFullName && (
              <PullRequestRepairButtons
                repositoryFullName={repoFullName}
                pullRequestNumber={step.repair.pullRequestNumber}
                kinds={step.repair.kinds}
                className="ml-6"
              />
            )}
            {step.detail && (
              <div className="ml-6 flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">判断根拠</span>
                <p className="max-h-32 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-line text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            )}
            {step.changelog && (
              <div className="ml-6 flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">更新履歴（利用者向け）</span>
                <p className="max-h-32 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-line text-muted-foreground">
                  {step.changelog}
                </p>
              </div>
            )}
            {step.action && (
              <GithubReferenceLink
                href={step.action.href}
                className={cn(
                  "ml-6 inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium",
                  step.state === "error"
                    ? "border-red-500/50 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
                    : "border-amber-500/50 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70",
                  text,
                )}
              >
                <LinkDestinationIcon href={step.action.href} />
                {step.action.label}
              </GithubReferenceLink>
            )}
            {step.link && (
              <GithubReferenceLink
                href={step.link.href}
                className={cn("ml-6 inline-flex items-center gap-1 text-primary hover:underline", "text-xs")}
              >
                {step.link.pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <LinkDestinationIcon href={step.link.href} />
                )}
                {step.link.label}
              </GithubReferenceLink>
            )}
            {step.note && step.state === "action" && (
              <span className="ml-6 text-xs text-muted-foreground">{step.note}</span>
            )}
          </li>
        ))}
      </ol>

      {nothingToDo && (
        <p className="text-xs text-muted-foreground">
          現在リリース対象の変更はありません（起動すると開始します）。
        </p>
      )}

      {workflowRun && (
        <a
          href={workflowRun.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("inline-flex items-center gap-1 text-primary hover:underline", "text-xs")}
        >
          {workflowRun.status !== "completed" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ExternalLink className="size-3.5" />
          )}
          {workflowRun.status !== "completed"
            ? "GitHub Actions 実行中"
            : workflowRun.conclusion === "success"
              ? "直近の実行: 成功"
              : workflowRun.conclusion === "failure"
                ? "直近の実行: 失敗"
                : `直近の実行: ${workflowRun.conclusion ?? workflowRun.status}`}
        </a>
      )}
    </div>
  );
}
