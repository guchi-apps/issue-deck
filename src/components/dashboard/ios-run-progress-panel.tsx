"use client";

import { Check, CircleAlert, Clock, Loader2, Minus } from "lucide-react";

import { useNow } from "@/hooks/use-now";
import type { IosTestflightRun } from "@/hooks/use-ios-testflight";
import { formatTimeOfDay } from "@/lib/format-date-time";
import { formatDuration } from "@/lib/format-duration";
import type { IosStageState, IosStageStatus } from "@/lib/ios-testflight-status";
import { cn } from "@/lib/utils";

/**
 * iOS配布（TestFlight）の内訳（#3665）。
 *
 * 本番デプロイの内訳（`workflow-run-progress-panel.tsx`）と同じ構造で、**緑を使わず青**にする。
 * Webのデプロイと並べたときに、iOSの成否がWebの成功と取り違えられないようにするため。
 * 行の単位はジョブではなく段階（`IOS_STAGES`）で、データは親が取得して渡す（自前では取らない）。
 */
const TICK_INTERVAL_MS = 1_000;

const STATE_ICON: Record<IosStageState, React.ReactNode> = {
  pending: <Clock className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />,
  running: <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />,
  success: <Check className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />,
  failure: <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />,
  skipped: <Minus className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />,
  unknown: <Minus className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden="true" />,
};

const STATE_LABEL: Record<IosStageState, string> = {
  pending: "待ち",
  running: "実行中",
  success: "成功",
  failure: "失敗",
  skipped: "スキップ",
  unknown: "—",
};

export type IosRunProgressSummary = {
  total: number;
  done: number;
  ratio: number;
  failed: boolean;
  isRunning: boolean;
  elapsedMs: number;
};

/** 完了した段階（成功・スキップ）の数と、実行全体の経過時間を出す */
export function summarizeIosRunProgress(run: IosTestflightRun, now: number): IosRunProgressSummary {
  const total = run.stages.length;
  const done = run.stages.filter((s) => s.state === "success" || s.state === "skipped").length;
  const isRunning = run.status !== "completed";
  const start = Date.parse(run.createdAt);
  const end = isRunning ? now : Date.parse(run.updatedAt);
  return {
    total,
    done,
    ratio: total === 0 ? 0 : done / total,
    failed: run.stages.some((s) => s.state === "failure"),
    isRunning,
    elapsedMs: Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start),
  };
}

function stageElapsedMs(stage: IosStageStatus, now: number): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  if (Number.isNaN(start)) return null;
  if (stage.completedAt) {
    const end = Date.parse(stage.completedAt);
    return Number.isNaN(end) ? null : Math.max(0, end - start);
  }
  return stage.state === "running" ? Math.max(0, now - start) : null;
}

function StageRow({ stage, now }: { stage: IosStageStatus; now: number }) {
  const elapsedMs = stageElapsedMs(stage, now);
  return (
    <li
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0",
        stage.state === "running" && "bg-blue-500/5",
        (stage.state === "pending" || stage.state === "skipped" || stage.state === "unknown") &&
          "text-muted-foreground",
      )}
    >
      {STATE_ICON[stage.state]}
      <span className="shrink-0 font-medium">{stage.label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", stage.state === "failure" && "text-destructive")}>
        {STATE_LABEL[stage.state]}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {elapsedMs !== null ? formatDuration(elapsedMs) : ""}
      </span>
    </li>
  );
}

export function IosRunProgressPanel({
  run,
  lastFetchedAt,
  autoRefreshLabel,
  className,
}: {
  run: IosTestflightRun;
  /** 最後に取得できた時刻（epoch ms）。無ければ出さない */
  lastFetchedAt: number | null;
  /** 「自動更新中（10秒）」のような表示。自動更新していなければ渡さない */
  autoRefreshLabel?: string;
  className?: string;
}) {
  const now = useNow(TICK_INTERVAL_MS, true);
  if (now === null) {
    return (
      <div className={cn("rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground", className)}>
        実行の内訳を取得しています…
      </div>
    );
  }
  const summary = summarizeIosRunProgress(run, now);

  return (
    <div className={cn("rounded-md border bg-card", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 pt-2">
        <span className="text-xs font-semibold">iOS配布の内訳</span>
        <span className="text-[11px] text-muted-foreground">
          iOS TestFlight
          {summary.total > 0 ? ` ・ ${summary.total}件中 ${summary.done}件が完了` : ""}
        </span>
        <span className="flex-1" />
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-muted-foreground hover:underline"
        >
          GitHubで実行ログを開く
        </a>
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-2 pt-1.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              summary.failed ? "bg-destructive" : "bg-blue-600 dark:bg-blue-500",
            )}
            style={{ width: `${Math.round(summary.ratio * 100)}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
          <span>
            {summary.isRunning ? "経過" : "所要"}{" "}
            <span className="font-medium text-foreground">{formatDuration(summary.elapsedMs)}</span>
          </span>
          {autoRefreshLabel && <span className="text-blue-700 dark:text-blue-400">{autoRefreshLabel}</span>}
        </div>
      </div>
      <ul className="border-t">
        {run.stages.map((stage) => (
          <StageRow key={stage.key} stage={stage} now={now} />
        ))}
      </ul>
      {run.notes.length > 0 && (
        <ul className="list-disc border-t px-3 py-1.5 pl-7 text-[11px] text-muted-foreground">
          {run.notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        段階はジョブ・ステップ名から判定しています。
        {lastFetchedAt !== null &&
          ` 最終取得 ${formatTimeOfDay(lastFetchedAt)}`}
      </p>
    </div>
  );
}
