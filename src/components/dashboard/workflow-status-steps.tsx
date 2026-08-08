import { Check, CircleAlert, MessageCircleQuestion } from "lucide-react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { getSimpleStepLabel } from "@/lib/github/workflow-step-label";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import { cn } from "@/lib/utils";
import type { IssueLabel } from "@/types/issue";

type WorkflowStatusStepsProps = {
  labels: IssueLabel[];
};

type WorkflowStepBadgeProps = {
  labels: IssueLabel[];
  /** GitHub Actions実行状況（一覧のポーリング結果）。省略時は実行中表示を行わない */
  running?: { isRunning: boolean; currentStep: string | null };
  /**
   * 「Claudeに質問する」ダイアログ経由の質問コメントが投稿済みで、まだ回答コメントが
   * 投稿されていない状態かどうか（@/lib/github/ask-claudeのisQaAnswerPending相当）
   */
  qaAnswerPending?: boolean;
};

const BADGE_SIZE = 18;

/**
 * 一覧などの省スペースな箇所向けに、現在の実装状況ステップを円グラフ（パイ）で示す。
 * ユーザーの確認待ち（00.check-user）の場合はamber色に切り替えたうえで中央にアラート
 * アイコンを重ね、一覧をざっと流し見しただけでも要対応Issueだと判別できるようにする。
 * Claudeへの質問が回答待ちの場合はblue色に切り替えたうえで中央に質問アイコンを重ねる
 * （承認待ちとは別系統の状態のため、両方成立する場合はより緊急度の高い承認待ち表示を優先する）。
 * GitHub Actionsの実行中は円の外周にスピン用のリングを重ねて回転させ、進捗（塗り分け）と
 * 実行中（回転）を同じ円で同時に表現する。
 */
export function WorkflowStepBadge({ labels, running, qaAnswerPending = false }: WorkflowStepBadgeProps) {
  const currentIndex = getWorkflowStepIndex(labels);
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);
  const showQaAnswerPending = qaAnswerPending && !approvalPending;
  const step = WORKFLOW_STEPS[currentIndex];
  const progress = (currentIndex + 1) / WORKFLOW_STEPS.length;
  const progressDeg = progress * 360;
  const isRunning = running?.isRunning ?? false;
  const simpleStep = isRunning ? getSimpleStepLabel(running?.currentStep ?? null) : null;
  const stepText = `${step.label}${simpleStep ? `（${simpleStep}）` : ""}`;
  const accentColorClass = approvalPending
    ? "text-amber-500"
    : showQaAnswerPending
      ? "text-blue-500"
      : "text-primary";

  return (
    <span
      title={`${step.labelName} ${step.label}${
        approvalPending ? "（ユーザーの確認待ち）" : showQaAnswerPending ? "（Claudeの回答待ち）" : ""
      }`}
      className="flex min-w-0 shrink-0 items-center gap-1.5"
    >
      <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">{stepText}</span>
      <span
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: BADGE_SIZE, height: BADGE_SIZE }}
      >
        {isRunning && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute animate-spin rounded-full border-2 border-transparent",
              approvalPending
                ? "border-t-amber-500"
                : showQaAnswerPending
                  ? "border-t-blue-500"
                  : "border-t-primary",
            )}
            style={{ inset: -3 }}
          />
        )}
        <span
          aria-hidden="true"
          className={cn("block rounded-full", accentColorClass)}
          style={{
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            background: `conic-gradient(currentColor 0deg ${progressDeg}deg, color-mix(in oklch, currentColor ${approvalPending || showQaAnswerPending ? 20 : 15}%, transparent) ${progressDeg}deg 360deg)`,
          }}
        />
        {approvalPending && (
          <span className="absolute inset-0 flex items-center justify-center">
            <CircleAlert className="size-2.5 text-background" />
          </span>
        )}
        {showQaAnswerPending && (
          <span className="absolute inset-0 flex items-center justify-center">
            <MessageCircleQuestion className="size-2.5 text-background" />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * 01.planning〜09.mainの実装状況ラベルをstep形式で可視化する。該当ラベルがないissueでは何も表示しない。
 * 円＋接続線の行はPC・スマホ共通で常時表示する。各ステップ下の個別ラベル（6個同時表示）はスマホの
 * 狭い横幅では重なって崩れるため`md`以上でのみ表示し、スマホでは代わりに現在ステップのみを示す
 * 1行キャプション（例:「実装中（2/6）」）を表示する。
 */
export function WorkflowStatusSteps({ labels }: WorkflowStatusStepsProps) {
  const currentIndex = getWorkflowStepIndex(labels);
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);
  const currentStep = WORKFLOW_STEPS[currentIndex];

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="flex min-w-max" role="list" aria-label="実装状況">
          {WORKFLOW_STEPS.map((step, index) => {
            const isDone = index < currentIndex;
            const isCurrent = index === currentIndex;
            const showApprovalPending = isCurrent && approvalPending;
            const StepIcon = step.icon;
            return (
              <div key={step.labelName} className="relative flex min-w-16 flex-1 flex-col items-center gap-1.5">
                {index !== 0 && (
                  <div
                    aria-hidden
                    className={cn(
                      "absolute left-0 top-3 h-px w-1/2",
                      isDone || isCurrent ? "bg-primary" : "bg-border",
                    )}
                  />
                )}
                {index !== WORKFLOW_STEPS.length - 1 && (
                  <div
                    aria-hidden
                    className={cn("absolute right-0 top-3 h-px w-1/2", isDone ? "bg-primary" : "bg-border")}
                  />
                )}
                <div
                  role="listitem"
                  aria-current={isCurrent ? "step" : undefined}
                  title={step.labelName}
                  className={cn(
                    "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-inset",
                    isDone && "bg-primary text-primary-foreground ring-primary",
                    isCurrent &&
                      (approvalPending
                        ? "bg-amber-500 text-white ring-2 ring-amber-500 dark:bg-amber-500 dark:text-background"
                        : "bg-[color-mix(in_oklch,var(--primary)_15%,var(--background))] text-primary ring-primary"),
                    !isDone && !isCurrent && "text-muted-foreground ring-border",
                  )}
                >
                  {isDone ? <Check className="size-3.5" /> : <StepIcon className="size-3.5" />}
                </div>
                <span
                  className={cn(
                    "hidden whitespace-nowrap text-center text-[11px] md:block",
                    isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
                {showApprovalPending && (
                  <span className="hidden whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-500 md:inline-block dark:text-amber-400">
                    ユーザー確認待ち
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 text-center text-[11px] md:hidden">
        <span className={cn("font-medium", approvalPending ? "text-amber-700 dark:text-amber-400" : "text-foreground")}>
          {currentStep.label}（{currentIndex + 1}/{WORKFLOW_STEPS.length}）
        </span>
        {approvalPending && (
          <span className="ml-1.5 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
            ユーザー確認待ち
          </span>
        )}
      </p>
    </div>
  );
}
