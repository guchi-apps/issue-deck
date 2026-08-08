import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import { cn } from "@/lib/utils";

type PullRequestCiStatusBadgeProps = {
  status: PullRequestCiStatus | null;
};

const STATUS_LABEL: Record<Exclude<PullRequestCiStatus, "none">, string> = {
  in_progress: "CI実行中",
  success: "CI成功",
  failure: "CI失敗",
};

/** マージ承認待ちカードで、対応PRの最新コミットのCI状態を表示する */
export function PullRequestCiStatusBadge({ status }: PullRequestCiStatusBadgeProps) {
  if (!status || status === "none") return null;

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        status === "in_progress"
          ? "bg-primary/15 text-primary ring-primary"
          : status === "failure"
            ? "bg-destructive/15 text-destructive ring-destructive"
            : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
