import { Check } from "lucide-react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import { cn } from "@/lib/utils";
import type { IssueLabel } from "@/types/issue";

type WorkflowStatusStepsProps = {
  labels: IssueLabel[];
};

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
                      : "bg-primary/15 text-primary ring-primary"),
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
