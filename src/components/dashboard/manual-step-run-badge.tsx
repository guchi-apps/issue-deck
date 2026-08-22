"use client";

import { ChevronDown, Loader2, Pause, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  describeManualStepRun,
  describeManualStepRunBadge,
  isFailedManualStepRun,
  manualStepRunProgressPercent,
  summarizeManualStepRuns,
  type ManualStepRunView,
} from "@/lib/manual-step-run-view";
import { cn } from "@/lib/utils";

/**
 * 「ユーザーの作業待ち」の帯に出す自動実行のバッジ（#1882）と、その中身（#2119）。
 *
 * **押すと走っている実行が全部並ぶ。** #1882のバッジは`.find`で拾った先頭1件ぶんの進捗しか
 * 出しておらず、2本目以降が走っていることが画面のどこにも出ていなかった。データ自体は
 * `GET /api/dispatch`（`listManualStepRunViews`）が全件返しているので、拾い方だけの問題だった。
 *
 * **行から開くのは手作業アシスタント**で、中断はその中の「中断する」のまま。ここから中断
 * できるようにすると、進み具合を見るつもりで開いた小さな面に、押し間違いで実行が消える操作が
 * 並ぶことになる。
 *
 * 表示だけを持ち、どのIssueを開くかの解決（`ManualStepRunView` → issue-deckのIssue id）は
 * 呼び出し側に任せる。`run.issueId`は引けないことがあり、一覧側は並んでいるIssueから
 * 確実に引けるため。
 */
export function ManualStepRunBadge({
  runs,
  onOpenRun,
}: {
  /** 走っている実行（呼び出し側で並び順まで決めて渡す）。空なら何も描かない */
  runs: readonly ManualStepRunView[];
  /** 行を押したとき。ポップオーバーは閉じてから呼ぶ */
  onOpenRun: (run: ManualStepRunView) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeManualStepRuns(runs);

  if (runs.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            "hover:bg-amber-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            summary.failed
              ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          <ManualStepRunStateIcon
            failed={summary.failed}
            running={summary.running}
            className="size-3"
          />
          {describeManualStepRunBadge(summary)}
          <ChevronDown
            className={cn("size-3 opacity-70 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <div className="flex items-baseline justify-between gap-2 border-b pb-2">
          <p className="text-sm font-medium">実行中の自動実行</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {summary.count}件 · {summary.done} / {summary.total}
          </p>
        </div>

        <div className="mt-1.5 flex flex-col gap-0.5">
          {runs.map((run) => (
            <ManualStepRunRow
              key={`${run.repositoryFullName}#${run.issueNumber}`}
              run={run}
              onOpen={() => {
                // 開いたまま後ろの画面だけが変わると何が起きたのか分からないので閉じる
                // （実行キューのポップオーバーと同じ作法）
                setOpen(false);
                onOpenRun(run);
              }}
            />
          ))}
        </div>

        <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">
          押すとその手作業アシスタントが開きます。閉じても実行は続きます。
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** 1件ぶんの行。押すとその手作業アシスタントが開く */
function ManualStepRunRow({ run, onOpen }: { run: ManualStepRunView; onOpen: () => void }) {
  const failed = isFailedManualStepRun(run);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-md p-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {run.issueTitle ?? `#${run.issueNumber}`}
        </span>
        <span className="shrink-0 text-[11px] font-semibold text-muted-foreground tabular-nums">
          {run.done} / {run.total}
        </span>
      </span>

      <span className="truncate font-mono text-[10px] text-muted-foreground">
        {run.repositoryFullName}#{run.issueNumber} · {run.targetHost}
      </span>

      {/* 進み具合。数字だけだと一覧を見渡したときにどれが進んでいるのか読み取れない */}
      <span
        className={cn(
          "block h-[3px] overflow-hidden rounded-full",
          failed ? "bg-destructive/20" : "bg-amber-500/20",
        )}
      >
        <span
          className={cn("block h-full", failed ? "bg-destructive" : "bg-amber-600 dark:bg-amber-400")}
          style={{ width: `${manualStepRunProgressPercent(run)}%` }}
        />
      </span>

      <span
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-semibold",
          failed ? "text-destructive" : "text-amber-700 dark:text-amber-300",
        )}
      >
        <ManualStepRunStateIcon
          failed={failed}
          running={run.status === "RUNNING"}
          className="size-3 shrink-0"
        />
        {describeManualStepRun(run)}
        {run.message !== null && (
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            ・{run.message}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * 状態の印。**走っているときだけ回す**——止まっているものに回転を出すと、放っておけば進むように
 * 見えてしまう（止まっていることに気づかないのが、この機能でいちばん困る状態）。
 */
function ManualStepRunStateIcon({
  failed,
  running,
  className,
}: {
  failed: boolean;
  running: boolean;
  className?: string;
}) {
  if (failed) return <TriangleAlert className={className} aria-hidden />;
  if (running) return <Loader2 className={cn(className, "animate-spin")} aria-hidden />;
  return <Pause className={className} aria-hidden />;
}
