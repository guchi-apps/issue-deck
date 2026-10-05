"use client";

import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2 } from "lucide-react";

import { useDispatchState } from "@/hooks/use-dispatch-state";
import {
  describeDispatchAgent,
  describeDispatchJobStatus,
  type DispatchJobTone,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  isPrReviewJobStale,
  parsePrReviewVerdict,
  PR_REVIEW_VERDICT_LABELS,
  selectPrReviewJobsForPullRequest,
} from "@/lib/dispatch/pr-review";
import { formatDateTime } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/**
 * サブPCで走るAIレビュー（`PR_REVIEW`・#3990）の状態。**状態の正本はDispatchJob**で、PRコメントの
 * 判定印ではない。キュー待ち・サブPC受付済み・実行中・完了・失敗・タイムアウト・古いHEADを区別し、
 * host・開始時刻・失敗理由を出す。起動前の失敗（実行できるサブPCが無い・サブPCが応答しない）も、
 * 最大30分待たずにここへ理由つきで出る。
 */
const TONE_CLASS: Record<DispatchJobTone, string> = {
  pending: "text-primary",
  running: "text-primary",
  success: "text-foreground",
  error: "text-destructive",
  muted: "text-muted-foreground",
};

function ToneIcon({ tone }: { tone: DispatchJobTone }) {
  const className = "size-3.5 shrink-0";
  switch (tone) {
    case "pending":
      return <Clock className={className} />;
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "success":
      return <CheckCircle2 className={className} />;
    case "error":
      return <AlertTriangle className={className} />;
    case "muted":
      return <Ban className={className} />;
  }
}

export function PullRequestAiReviewJobsView({
  jobs,
  headSha,
}: {
  jobs: DispatchJobView[];
  headSha: string;
}) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label="サブPCのAIレビュー" className="flex flex-col gap-1.5 border-b px-4 py-3">
      <h2 className="text-xs font-semibold text-muted-foreground">サブPCのAIレビュー</h2>
      <ul className="flex flex-col gap-1.5">
        {jobs.map((job) => {
          const stale = isPrReviewJobStale(job, headSha);
          const { label, tone } = describeDispatchJobStatus(job.status, job.kind);
          const verdict = parsePrReviewVerdict(job.reviewVerdict);
          const showMessage = job.message && (job.status === "FAILED" || job.status === "TIMEOUT" || job.status === "SKIPPED");
          return (
            <li key={job.id} className="flex flex-col gap-0.5 text-xs">
              <div className={cn("flex flex-wrap items-center gap-1.5", TONE_CLASS[stale ? "muted" : tone])}>
                <ToneIcon tone={stale ? "muted" : tone} />
                <span className="font-medium">
                  {describeDispatchAgent(job.agent)}: {label}
                </span>
                {verdict && <span>（{PR_REVIEW_VERDICT_LABELS[verdict]}）</span>}
                {stale && job.status !== "CANCELED" && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    古いHEAD（結果は使いません）
                  </span>
                )}
              </div>
              <p className="pl-5 text-muted-foreground">
                {job.headSha ? `${job.headSha.slice(0, 7)} · ` : ""}
                {formatDispatchHostName(job.targetHost)}
                {" · "}
                {job.startedAt ? `開始 ${formatDateTime(job.startedAt)}` : `積んだ時刻 ${formatDateTime(job.createdAt)}`}
              </p>
              {showMessage && <p className="pl-5 break-words text-destructive">{job.message}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PullRequestAiReviewJobs({
  repositoryFullName,
  prNumber,
  headSha,
}: {
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
}) {
  const { jobs } = useDispatchState(true);
  return (
    <PullRequestAiReviewJobsView
      jobs={selectPrReviewJobsForPullRequest(jobs, repositoryFullName, prNumber)}
      headSha={headSha}
    />
  );
}
