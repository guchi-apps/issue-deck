"use client";

import { Check, CircleAlert, Clock, Loader2, Minus, SkipForward } from "lucide-react";

import { useNow } from "@/hooks/use-now";
import { useWorkflowRunProgress } from "@/hooks/use-workflow-run-progress";
import { formatDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import {
  jobElapsedMs,
  summarizeWorkflowRunProgress,
  toCiRunProgress,
  type RollupCiCheckLike,
  type WorkflowRunJobState,
  type WorkflowRunJobView,
} from "@/lib/workflow-run-progress";

/**
 * GitHub Actionsの実行の内訳（#2777）。
 *
 * **本番デプロイ（ブランチ画面）とCI（PR詳細）で同じ部品を使う。** どちらもActionsの実行で、
 * 見たいこと（ジョブがどこまで進んだか・あと何分か）は同じ。状態の種類ごとに見た目を分けると、
 * 同じことを2つの言い方で説明することになる。
 *
 * 取得は`open`のあいだだけ走る（`use-workflow-run-progress.ts`）。閉じている間はGitHub APIを
 * 一切消費しない。
 */
type WorkflowRunProgressPanelProps = {
  /** `owner/repo` */
  repositoryFullName: string;
  /** 内訳を取りにいく実行。読めていなければnull（`checks`だけで描く） */
  runId: number | null;
  /** パネルが開いているか。falseの間は取得もしない */
  open: boolean;
  /** 見出し（「本番デプロイの内訳」「CIの内訳」） */
  title: string;
  /**
   * CIのチェック一覧（#2777）。渡すと**行はこちらを正とし**、`runId`の実行は
   * 現在ステップと見込み時間を足すためだけに使う。理由は`toCiRunProgress`を参照。
   */
  checks?: readonly RollupCiCheckLike[];
  className?: string;
};

/** 経過時間を1秒ごとに描き替える間隔 */
const TICK_INTERVAL_MS = 1_000;

const JOB_STATE_ICON: Record<WorkflowRunJobState, React.ReactNode> = {
  queued: <Clock className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />,
  running: <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />,
  success: <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />,
  failure: <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />,
  cancelled: <Minus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />,
  skipped: <SkipForward className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />,
};

const JOB_STATE_LABEL: Record<WorkflowRunJobState, string> = {
  queued: "待ち",
  running: "実行中",
  success: "成功",
  failure: "失敗",
  cancelled: "キャンセル",
  skipped: "スキップ",
};

/**
 * ジョブ1行の右に出す説明。**実行中は現在のステップ名**を出す（「どこまで進んだか」の実体は
 * ここにある）。待ちのジョブには、直近の成功した実行での所要時間を目安として添える。
 */
function jobNote(job: WorkflowRunJobView): string {
  if (job.state === "running") {
    return job.currentStep ? `実行中: ${job.currentStep}` : "実行中";
  }
  if (job.state === "failure") {
    return job.currentStep ? `失敗: ${job.currentStep}` : "失敗";
  }
  if (job.state === "queued") {
    return job.baselineMs !== null ? `待ち（通常 ${formatDuration(job.baselineMs)}）` : "待ち";
  }
  return JOB_STATE_LABEL[job.state];
}

function JobRow({ job, now }: { job: WorkflowRunJobView; now: number }) {
  const elapsedMs = jobElapsedMs(job, now);
  return (
    <li
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0",
        job.state === "running" && "bg-primary/5",
        job.state === "queued" && "text-muted-foreground",
      )}
    >
      {JOB_STATE_ICON[job.state]}
      {/* ジョブ名は英語のまま出す。GitHubの実行ログと突き合わせる値なので、訳すと照合できない */}
      <span className="shrink-0 font-medium">{job.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{jobNote(job)}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {elapsedMs !== null ? formatDuration(elapsedMs) : ""}
      </span>
    </li>
  );
}

export function WorkflowRunProgressPanel({
  repositoryFullName,
  runId,
  open,
  title,
  checks,
  className,
}: WorkflowRunProgressPanelProps) {
  const { progress: run, isLoading, error } = useWorkflowRunProgress(repositoryFullName, runId, open);
  // 描画中に`Date.now()`を呼ばず、時計から受け取る（docs/code-map.md「時刻を見る判定は`now`を
  // 引数で受け取る」）。**開いている間は実行が終わっていても回す**——止めると、完了済みの実行を
  // 開いたときに時刻が来ないまま何も出せなくなる。
  const tickedNow = useNow(TICK_INTERVAL_MS, open);

  if (!open) return null;

  const progress =
    checks && checks.length > 0 ? toCiRunProgress(checks, run, tickedNow ?? 0) : run;

  if (!progress || tickedNow === null) {
    return (
      <div
        className={cn("rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground", className)}
      >
        {error ?? (isLoading || tickedNow === null ? "実行の内訳を取得しています…" : "実行の内訳がありません")}
      </div>
    );
  }

  const now = tickedNow;
  const summary = summarizeWorkflowRunProgress(progress, now);

  return (
    <div className={cn("rounded-md border bg-card", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 pt-2">
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground">
          {progress.workflowName ?? "GitHub Actions"}
          {progress.runAttempt > 1 ? ` ・ ${progress.runAttempt}回目の試行` : ""}
          {summary.jobCount > 0
            ? ` ・ ${summary.jobCount}件中 ${summary.doneJobCount}件が完了`
            : ""}
        </span>
        <span className="flex-1" />
        {progress.htmlUrl && (
          // 実行ログはアプリ内に対応する画面が無いので別タブで開く（`release-progress.tsx`と同じ）
          <a
            href={progress.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground hover:underline"
          >
            GitHubで実行ログを開く
          </a>
        )}
      </div>

      <div className="flex flex-col gap-1.5 px-3 pb-2 pt-1.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              summary.failed ? "bg-destructive" : summary.isRunning ? "bg-primary" : "bg-green-600",
            )}
            style={{ width: `${Math.round(summary.ratio * 100)}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
          <span>
            {summary.isRunning ? "経過" : "所要"}{" "}
            <span className="font-medium text-foreground">{formatDuration(summary.elapsedMs)}</span>
          </span>
          {summary.isRunning && progress.estimateMs !== null && (
            <span>
              見込み{" "}
              <span className="font-medium text-foreground">
                約{formatDuration(progress.estimateMs)}
              </span>
              {summary.remainingMs !== null ? `（残り約${formatDuration(summary.remainingMs)}）` : ""}
            </span>
          )}
          {summary.overEstimate && <span className="text-amber-700 dark:text-amber-400">見込みを超過</span>}
        </div>
      </div>

      <ul className="border-t">
        {progress.jobs.map((job) => (
          <JobRow key={`${job.name}-${job.startedAt ?? ""}`} job={job} now={now} />
        ))}
      </ul>

      <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {progress.estimateMs !== null
          ? "見込みは、直近の成功した実行の所要時間の中央値です。"
          : "成功した実行の実績が足りないため、見込みは出していません。"}
      </p>
    </div>
  );
}
