import { Check, CircleAlert } from "lucide-react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import { cn } from "@/lib/utils";
import type { IssueLabel } from "@/types/issue";

type WorkflowStatusStepsProps = {
  labels: IssueLabel[];
};

type WorkflowStepBadgeProps = {
  labels: IssueLabel[];
};

const BADGE_SIZE = 18;
const BADGE_STROKE_WIDTH = 2.5;
const BADGE_RADIUS = (BADGE_SIZE - BADGE_STROKE_WIDTH) / 2;
const BADGE_CIRCUMFERENCE = 2 * Math.PI * BADGE_RADIUS;

/**
 * 一覧などの省スペースな箇所向けに、現在の実装状況ステップを進捗リング（円弧）で示す。
 * ユーザーの確認待ち（00.check-user）の場合は数字の代わりにアラートアイコンへ切り替え、
 * amber色で強調することで一覧をざっと流し見しただけでも要対応Issueだと判別できるようにする。
 */
export function WorkflowStepBadge({ labels }: WorkflowStepBadgeProps) {
  const currentIndex = getWorkflowStepIndex(labels);
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);
  const step = WORKFLOW_STEPS[currentIndex];
  const progress = (currentIndex + 1) / WORKFLOW_STEPS.length;
  const dashOffset = BADGE_CIRCUMFERENCE * (1 - progress);

  return (
    <span
      title={`${step.labelName} ${step.label}${approvalPending ? "（ユーザーの確認待ち）" : ""}`}
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: BADGE_SIZE, height: BADGE_SIZE }}
    >
      <svg
        width={BADGE_SIZE}
        height={BADGE_SIZE}
        viewBox={`0 0 ${BADGE_SIZE} ${BADGE_SIZE}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={BADGE_SIZE / 2}
          cy={BADGE_SIZE / 2}
          r={BADGE_RADIUS}
          fill="none"
          strokeWidth={BADGE_STROKE_WIDTH}
          className={approvalPending ? "stroke-amber-500/20" : "stroke-primary/15"}
        />
        <circle
          cx={BADGE_SIZE / 2}
          cy={BADGE_SIZE / 2}
          r={BADGE_RADIUS}
          fill="none"
          strokeWidth={BADGE_STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={BADGE_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          className={approvalPending ? "stroke-amber-500" : "stroke-primary"}
        />
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center text-[8px] font-semibold",
          approvalPending ? "text-amber-600 dark:text-amber-400" : "text-primary",
        )}
      >
        {approvalPending ? <CircleAlert className="size-2.5" /> : currentIndex + 1}
      </span>
    </span>
  );
}

/** 01.wip〜09.mainの実装状況ラベルをstep形式で可視化する。該当ラベルがないissueでは何も表示しない */
export function WorkflowStatusSteps({ labels }: WorkflowStatusStepsProps) {
  const currentIndex = getWorkflowStepIndex(labels);
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max" role="list" aria-label="実装状況">
        {WORKFLOW_STEPS.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;
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
                  "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium ring-1 ring-inset",
                  isDone && "bg-primary text-primary-foreground ring-primary",
                  isCurrent &&
                    (approvalPending
                      ? "text-amber-600 ring-amber-500 dark:text-amber-400"
                      : "bg-[color-mix(in_oklch,var(--primary)_15%,var(--background))] text-primary ring-primary"),
                  !isDone && !isCurrent && "text-muted-foreground ring-border",
                )}
              >
                {isDone ? <Check className="size-3.5" /> : index + 1}
              </div>
              <span
                className={cn(
                  "whitespace-nowrap text-center text-[11px]",
                  isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
      {approvalPending && (
        <p className="mt-1.5 text-center text-[11px] text-amber-600 dark:text-amber-400">
          ユーザーの確認待ちです
        </p>
      )}
    </div>
  );
}
