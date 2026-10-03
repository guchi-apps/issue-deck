import { CircleCheck, CircleDot, RefreshCw, Wrench } from "lucide-react";

import { resolvePullRequestReviewRound } from "@/lib/github/pull-request-review-round";
import { canMergeFromDeck } from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

export function PullRequestReviewRound({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const round = resolvePullRequestReviewRound({
    reviewVerdict: pullRequest.reviewVerdict,
    headSha: pullRequest.headSha,
    repairRun: pullRequest.repairRun,
    reviewPending: pullRequest.mergeJudgement.aiReview.state === "pending",
    autoMergeEnabled: pullRequest.autoMergeEnabled,
    readyToMerge:
      canMergeFromDeck(pullRequest) &&
      pullRequest.ciState === "success" &&
      pullRequest.mergeJudgement.aiReview.state === "passed",
  });
  const icon = round.state === "fixing" ? <Wrench className="size-4" /> : round.state === "re-reviewing" || round.state === "reviewing" ? <RefreshCw className="size-4" /> : round.state === "changes-requested" ? <CircleDot className="size-4" /> : <CircleCheck className="size-4" />;
  const tone = round.state === "changes-requested" ? "border-destructive/40 bg-destructive/10 text-destructive" : round.state === "fixing" || round.state === "re-reviewing" || round.state === "reviewing" ? "border-primary/35 bg-primary/10 text-primary" : "border-green-600/35 bg-green-600/10 text-green-700 dark:text-green-400";

  return <section className={cn("flex items-start gap-2 border-b px-4 py-3 text-sm", tone)}><span className="mt-0.5 shrink-0">{icon}</span><div><p className="font-semibold">仕上げ: {round.label}</p><p className="mt-0.5 text-xs opacity-90">{round.description}</p></div></section>;
}
