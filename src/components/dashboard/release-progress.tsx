"use client";

import { Check, CircleAlert, Clock, ExternalLink, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CiState, ReleaseStatus, ReleaseWorkflowRun } from "@/hooks/use-release-status";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

type StepState =
  | "done" // 完了
  | "active" // 進行中（自動で進む。人の操作は不要）
  | "action" // 要操作（人がマージする。マージ用URLを添付する）
  | "error" // 失敗（デプロイ失敗など。人が内容を確認する）
  | "todo"; // 未着手（待ち）

type Step = {
  label: string;
  state: StepState;
  /** 補足文（CI状態や次に起きることの説明） */
  note?: string;
  /** 要操作・要確認段で表示するリンク（マージ用URL、デプロイ失敗時のrun URLなど） */
  action?: { href: string; label: string };
  /** 参考リンク（要操作ではない。実行中・完了段でrun詳細への導線として添える） */
  link?: { href: string; label: string; pending?: boolean };
};

function ciLabel(ci: CiState | null): string {
  switch (ci) {
    case "pending":
      return "CI実行中";
    case "success":
      return "CI通過";
    case "failure":
      return "CI失敗";
    default:
      return "CI状態は不明";
  }
}

/**
 * リリースの論理段階（4ステップ）を、版数・オープン中PR・実行中runから組み立てる。
 * 人の操作（マージ）が必要な段には、その場でマージできるPRのURLを`action`として添える。
 * mainの本番デプロイ（deploy.yml）のrunが取得できれば、5段目として末尾に追加する。
 */
function buildSteps(status: AvailableReleaseStatus): Step[] {
  const { phase, bumpPullRequest: bump, releasePullRequest: release, workflowRun, developVersion } = status;
  const runActive = workflowRun != null && workflowRun.status !== "completed";

  const steps: Step[] = [
    { label: "バンプPR作成", state: "todo" },
    { label: "develop反映（バンプPRのマージ）", state: "todo" },
    { label: "develop→main PR作成", state: "todo" },
    { label: "mainへマージ", state: "todo" },
  ];

  if (phase === "bump_pr_open" && bump) {
    steps[0].state = "done";
    steps[0].note = bump.version ? `次バージョン: v${bump.version}` : undefined;
    // CIが実行中の間は自動マージ待ちの「進行中」、それ以外はスマホから1タップでマージできる「要操作」。
    const waitingCi = bump.ciState === "pending";
    steps[1].state = waitingCi ? "active" : "action";
    steps[1].note = ciLabel(bump.ciState);
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
    steps[2].state = "active";
    steps[2].note = "developへ反映済み。まもなくdevelop→mainのPRを自動作成します（起動ボタンでも作成できます）。";
  } else if (phase === "release_pr_open" && release) {
    steps[0].state = "done";
    steps[0].note = developVersion ? `次バージョン: v${developVersion}` : undefined;
    steps[1].state = "done";
    steps[2].state = "done";
    steps[3].state = "action";
    steps[3].note = "最終マージは人が行います。内容を確認してmainへマージしてください（マージ方式は必ず「Create a merge commit」）。";
    steps[3].action = {
      href: release.url,
      label: `develop→main PR #${release.number} をタップしてmainへマージ`,
    };
  } else if (runActive) {
    // まだPRが現れていないが実行中（起動直後）。最初の段を進行中にする。
    steps[0].state = "active";
    steps[0].note = "ワークフロー実行中...";
  }

  const deployStep = buildDeployStep(status.deployWorkflowRun);
  if (deployStep) steps.push(deployStep);

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
}: {
  status: AvailableReleaseStatus;
  compact?: boolean;
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
              {step.note && step.state !== "action" && (
                <span className={cn("text-xs text-muted-foreground")}>{step.note}</span>
              )}
            </div>
            {step.action && (
              <a
                href={step.action.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "ml-6 inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium",
                  step.state === "error"
                    ? "border-red-500/50 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
                    : "border-amber-500/50 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70",
                  text,
                )}
              >
                <ExternalLink className="size-3.5" />
                {step.action.label}
              </a>
            )}
            {step.link && (
              <a
                href={step.link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn("ml-6 inline-flex items-center gap-1 text-primary hover:underline", "text-xs")}
              >
                {step.link.pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="size-3.5" />
                )}
                {step.link.label}
              </a>
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
