"use client";

import { AlertTriangle, ListOrdered, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  isCancelableDispatchJobStatus,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  cancelableDispatchJobs,
  describeDispatchQueueLoad,
  describeDispatchQueueStall,
  summarizeDispatchQueue,
  summarizeDispatchSessionCapacity,
} from "@/lib/dispatch/queue-summary";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 実行キューの一覧（#1266）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめ、**サブPCで順に流す**形にしたため（#1261）、
 * 「今どこまで進んでいて、あと何本待っているか」を1か所で見られる必要が出た。従来はジョブの
 * 状態がIssue詳細のボタンの下にしか出ず、**キュー全体を見る場所が無かった**。
 *
 * **並びは`createdAt`の昇順で、払い出し（`claimDispatchJob`）と同じ。** 画面の順番と実際に
 * 走る順番が一致する。
 *
 * 取り消せるのは`QUEUED`と`CLAIMED`まで。`RUNNING`はworktreeの作成や依存インストールの最中で、
 * 途中で止めると中途半端なworktreeとブランチが残る（#1179の取り決めをそのまま守る）。
 */
export function DispatchQueueButton({ dispatch: injected }: { dispatch?: DispatchStateHandle }) {
  const own = useDispatchState(injected === undefined);
  const dispatch = injected ?? own;
  const summary = summarizeDispatchQueue(dispatch.jobs, dispatch.concurrency);
  // 起動を実際に止めているのはセッション本数の上限（#1361）で、同時実行数では説明できない（#1394）
  const capacities = summarizeDispatchSessionCapacity(dispatch.hosts);
  const stall = describeDispatchQueueStall(summary, dispatch.hosts);

  // 申告しているホストが1台も無ければ、キューという概念自体が無い
  if (dispatch.hosts.length === 0) return null;

  const cancelable = cancelableDispatchJobs(summary);

  async function cancelAll() {
    // 1件ずつ順に投げる。**まとめて投げると、拒否された理由がどれのものか分からなくなる**
    for (const job of cancelable) {
      await dispatch.cancel(job.id);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex items-center gap-1 rounded-md p-1.5 hover:bg-accent"
          aria-label="実行キュー"
          title={`実行キュー（${describeDispatchQueueLoad(summary)}）`}
        >
          <ListOrdered className="size-4" />
          {summary.activeCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              {summary.activeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">実行キュー</p>
          <p className="text-xs text-muted-foreground">{describeDispatchQueueLoad(summary)}</p>
        </div>

        {/*
          セッションの本数と上限（#1394）。**同時実行数の隣に並べて出す。** 名前が似ていて
          役割が違う2つの上限を別の場所に置くと、どちらが起動を止めているのか読み取れない。
          申告していない古いpollerのホストはここに出ない（`summarizeDispatchSessionCapacity`）
        */}
        {capacities.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5">
            {capacities.map((capacity) => (
              <li
                key={capacity.hostName}
                className={cn(
                  "text-xs text-muted-foreground",
                  capacity.atCapacity && "text-destructive",
                )}
              >
                {formatDispatchHostName(capacity.hostName)}のセッション {capacity.live}/{capacity.max}
              </li>
            ))}
          </ul>
        )}

        {/* 順番待ちが進まない理由。無いと「押しても何も起きない」としか見えない（#1394） */}
        {stall && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{stall}</span>
          </p>
        )}

        {summary.activeCount === 0 && summary.failed.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            積まれているジョブはありません。Issueの「実装を開始」から積むと、上限
            {summary.concurrency === null ? "" : `（${summary.concurrency}本）`}
            まで並行し、あとは順番に流れます。
          </p>
        )}

        <QueueSection title="実行中" jobs={summary.running} onCancel={dispatch.cancel} />
        <QueueSection title="順番待ち" jobs={summary.queued} onCancel={dispatch.cancel} showOrder />
        <QueueSection title="直近の失敗" jobs={summary.failed} onCancel={null} />

        {cancelable.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            disabled={dispatch.isSubmitting}
            onClick={() => void cancelAll()}
          >
            {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <X />}
            まとめて取り消す（{cancelable.length}件）
          </Button>
        )}
        {dispatch.error && <p className="mt-2 text-xs text-destructive">{dispatch.error}</p>}
      </PopoverContent>
    </Popover>
  );
}

function QueueSection({
  title,
  jobs,
  onCancel,
  showOrder = false,
}: {
  title: string;
  jobs: DispatchJobView[];
  /**
   * `null`なら取り消しボタンを出さない（終わったジョブ）。渡した場合も、**取り消せる状態の
   * 行にだけ**ボタンを出す（`RUNNING`はworktreeの作成途中で、止めると中途半端な状態が残る）。
   */
  onCancel: ((jobId: string) => Promise<boolean>) | null;
  showOrder?: boolean;
}) {
  if (jobs.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {jobs.map((job, index) => {
          // 種別を必ず渡す（#1294。省略すると種別が増えたときに文言が黙って「起動しました」になる）
          const status = describeDispatchJobStatus(job.status, job.kind);
          return (
            <li key={job.id} className="flex items-start gap-2 text-xs">
              {showOrder && (
                <span className="mt-0.5 w-4 shrink-0 text-right text-muted-foreground">
                  {index + 1}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {job.repositoryFullName.split("/")[1]} #{job.issueNumber}
                </span>
                <span
                  className={cn(
                    "block truncate text-muted-foreground",
                    status.tone === "error" && "text-destructive",
                  )}
                >
                  {formatDispatchHostName(job.targetHost)}・{status.label}・
                  {formatRelativeDate(job.createdAt)}
                </span>
                {/* 失敗理由はホバーではなく本文で出す（主な用途が外出先のスマホ） */}
                {job.message && (
                  <span className="block whitespace-normal text-muted-foreground">{job.message}</span>
                )}
              </span>
              {onCancel && isCancelableDispatchJobStatus(job.status) && (
                <button
                  type="button"
                  aria-label={`#${job.issueNumber}のジョブを取り消す`}
                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void onCancel(job.id)}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
