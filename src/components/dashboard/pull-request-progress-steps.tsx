import { Loader2 } from "lucide-react";

import type {
  IssuePullRequestProgress,
  IssuePullRequestStepState,
} from "@/lib/issue-pull-request-progress";
import { cn } from "@/lib/utils";

/**
 * PRの進捗の内訳（#2816）を描く2つの部品。Issue詳細の上部（`WorkflowStatusSteps`）と、
 * 下部の対応PRの各行（`IssuePullRequestList`。#3239）が**同じ部品を通す**——上下で言い方や
 * 記号が食い違うと、同じPRなのに別の状態を言っているように読める。材料は
 * `buildIssuePullRequestProgress`の結果で、文言・状態はそちらが決める。
 */

/** PR進捗の状態記号。工程名と状態を分け、色だけに頼らず読めるようにする。 */
const PR_STEP_STATUS: Record<IssuePullRequestStepState, { label: string; className: string }> = {
  done: { label: "✔", className: "text-emerald-700 dark:text-emerald-400" },
  current: { label: "実施中", className: "text-primary" },
  failed: { label: "×", className: "text-destructive" },
  pending: { label: "—", className: "text-muted-foreground" },
  "needs-check": { label: "△", className: "text-amber-700 dark:text-amber-400" },
};

/**
 * 「いま何を待っているか」の1語（判定実施中・CI失敗・マージ待ちなど）。
 *
 * 待っているのが処理なら回す。人待ち（マージ待ち）は回さない——一覧の進捗バーと同じ使い分けで、
 * 動きが「放っておけば進む」ことの合図になっている。
 */
export function PullRequestProgressLabel({ progress }: { progress: IssuePullRequestProgress }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-semibold",
        progress.tone === "attention"
          ? "text-destructive"
          : progress.tone === "waiting"
            ? "text-amber-700 dark:text-amber-400"
            : "text-foreground",
      )}
    >
      {progress.tone === "running" && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
      {progress.label}
    </span>
  );
}

/** 工程ごとに✔・×・実施中を並べた一覧。レビューは工程名「レビュー」＋状態で出る */
export function PullRequestProgressStepList({
  progress,
  reviewRunUrl = null,
  className,
}: {
  progress: IssuePullRequestProgress;
  /**
   * レビュー（判定）の実行ログのURL。渡すとレビューの段だけ、そのログへのリンクにする。
   * 対応PRの行が、バッジの頃から持っていた「押すと実行ログへ行ける」を引き継ぐための口
   * （#2150）。上部はPR単位の行ではないので渡さない。
   */
  reviewRunUrl?: string | null;
  className?: string;
}) {
  return (
    <ul
      className={cn("flex flex-wrap gap-x-4 gap-y-2 text-xs", className)}
      aria-label="developへマージの内訳"
    >
      {progress.steps.map((step) => {
        const status = PR_STEP_STATUS[step.state];
        const content = (
          <>
            <span className="font-medium">{step.label}</span>
            <span className={cn("font-semibold", status.className)}>
              {step.statusText ?? status.label}
            </span>
          </>
        );
        const linkable = step.key === "ai-review" && reviewRunUrl !== null;
        return (
          <li key={step.key} className="inline-flex items-center gap-1.5" title={step.detail}>
            {linkable ? (
              <a
                href={reviewRunUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:underline"
                title={`${step.detail ?? step.label}（クリックで実行ログを開きます）`}
              >
                {content}
              </a>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}
