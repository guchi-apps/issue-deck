import { cn } from "@/lib/utils";
import type { PlanReviewListState } from "@/lib/dispatch/plan-review-list-state";

/**
 * Issue一覧の行に出す計画レビューの状態バッジ（#3607）。判定は`resolvePlanReviewListState`。
 * 「作成中」は青（処理が動いている）、「提示済」は緑（人の承認を待っている）。
 */
export function PlanReviewStateBadge({ state }: { state: PlanReviewListState }) {
  const creating = state === "creating";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]",
        creating
          ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : "bg-green-500/10 text-green-700 dark:text-green-300",
      )}
    >
      {creating && (
        <span className="size-2 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />
      )}
      {creating ? "計画レビュー作成中" : "計画レビュー提示済"}
    </span>
  );
}
