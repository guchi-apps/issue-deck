import { CircleAlert } from "lucide-react";

import { describeCheckState, type MergeFailure } from "@/lib/github/merge-failure";
import { cn } from "@/lib/utils";

type PullRequestMergeFailureProps = {
  failure: MergeFailure;
  className?: string;
};

const CHECK_STATE_TONE: Record<NonNullable<MergeFailure["check"]>["state"], string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  pending: "text-amber-600 dark:text-amber-400",
  failure: "text-destructive",
  missing: "text-muted-foreground",
};

/**
 * GitHubがマージを拒んだ理由の説明（#4878）。見出し・理由・必須チェックのいまの状態・次の操作を
 * 折り返して出し、GitHubの原文は折りたたみに残す。一覧の行など狭い場所では使わず、見出しだけを出す。
 */
export function PullRequestMergeFailure({ failure, className }: PullRequestMergeFailureProps) {
  return (
    <div
      role="alert"
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-left", className)}
    >
      <p className="flex items-start gap-1.5 text-sm font-semibold text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{failure.title}</span>
      </p>
      {failure.reason && <p className="text-xs text-foreground">{failure.reason}</p>}
      {failure.check && (
        <p className="text-xs text-muted-foreground">
          <span className={cn("font-medium", CHECK_STATE_TONE[failure.check.state])}>● </span>
          {failure.checkName && <span className="font-mono">{failure.checkName}</span>}
          {failure.checkName && " — "}
          {describeCheckState(failure.check)}
        </p>
      )}
      {failure.next && <p className="text-xs text-muted-foreground">{failure.next}</p>}
      {failure.githubMessage && failure.githubMessage !== failure.reason && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">GitHubの応答（HTTP {failure.httpStatus}）</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 font-mono text-[11px]">
            {failure.githubMessage}
          </pre>
        </details>
      )}
    </div>
  );
}
