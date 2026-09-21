"use client";

import { CalendarClock, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BulkReserveSummary } from "@/hooks/use-bulk-reserve";
import { cn } from "@/lib/utils";

/**
 * Issue一覧の一括予約（#3284）の2つのバー。PC・iPad・スマホの一覧（`IssueList`）で共通。
 *
 * - `BulkReserveEntryBar`: 一覧の上の1行。選択モードの入口と出口
 * - `BulkReserveDock`: 一覧の下端に固定する登録バー。**選択中と、結果を伝えるあいだだけ出す**
 */
export function BulkReserveEntryBar({
  active,
  disabled,
  onStart,
  onExit,
  className,
}: {
  active: boolean;
  disabled: boolean;
  onStart: () => void;
  onExit: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2",
        active && "border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950",
        className,
      )}
    >
      <p
        className={cn(
          "min-w-0 grow basis-48 text-xs",
          active ? "text-indigo-800 dark:text-indigo-200" : "text-muted-foreground",
        )}
      >
        {active
          ? "予約するIssueを選んでください。積めない行は理由を出しています。"
          : "未着手のIssueをまとめて予約実行に積めます。"}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {active ? (
          <Button size="xs" variant="outline" onClick={onExit}>
            選択を終了
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={onStart} disabled={disabled}>
            <CalendarClock />
            まとめて予約
          </Button>
        )}
      </div>
    </div>
  );
}

export function BulkReserveDock({
  active,
  selectedCount,
  selectableCount,
  hostNames,
  progress,
  summary,
  onSelectAll,
  onClear,
  onSubmit,
  onDismissSummary,
  onOpenNightlyRun,
}: {
  active: boolean;
  selectedCount: number;
  /** 選べる行の数（「全選択」で選べるもの） */
  selectableCount: number;
  /** 選んだ行の起動先のホスト名（重複なし）。複数なら並べて出す */
  hostNames: readonly string[];
  progress: { done: number; total: number } | null;
  summary: BulkReserveSummary | null;
  onSelectAll: () => void;
  onClear: () => void;
  onSubmit: () => void;
  onDismissSummary: () => void;
  onOpenNightlyRun?: () => void;
}) {
  const submitting = progress !== null;
  // 結果を伝えている間（選択モードを閉じた後の全件成功を含む）
  const result = !submitting && summary ? summary : null;
  const summaryText = result
    ? result.failed === 0
      ? `${result.queued}件を予約しました`
      : `${result.queued}件を予約・${result.failed}件は積めませんでした`
    : null;

  return (
    <div
      role="region"
      aria-label="予約実行への登録"
      // 一覧の列の下端に固定する（`IssueList`のルートは縦flexで、これは最後の子）。
      // スマホはこの下にボトムナビが並ぶので、ナビの上に乗る
      className="shrink-0 border-t border-indigo-200 bg-background px-4 py-2.5 shadow-[0_-6px_18px_rgba(20,20,40,0.10)] dark:border-indigo-800"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span
            className={cn(
              "text-sm font-bold tabular-nums",
              result && (result.failed === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"),
            )}
            aria-live="polite"
          >
            {submitting
              ? `${progress.total}件中 ${progress.done}件を登録中…`
              : (summaryText ?? `${selectedCount}件を選択中`)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {submitting
              ? "閉じずにお待ちください"
              : active
                ? `実行先 ${hostNames.length > 0 ? hostNames.join("・") : "―"} ・ 選べるのは${selectableCount}件`
                : "予約実行の画面で確認できます"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active && !submitting && (
            <>
              <Button size="xs" variant="outline" onClick={onSelectAll} disabled={selectableCount === 0}>
                全選択
              </Button>
              <Button size="xs" variant="ghost" onClick={onClear} disabled={selectedCount === 0}>
                解除
              </Button>
              <Button
                size="sm"
                className="min-w-0 flex-1"
                onClick={onSubmit}
                disabled={selectedCount === 0}
              >
                {selectedCount === 0
                  ? "Issueを選んでください"
                  : `次の5時間枠に${selectedCount}件を予約`}
              </Button>
            </>
          )}
          {submitting && (
            <Button size="sm" className="min-w-0 flex-1" disabled>
              <Loader2 className="animate-spin" />
              登録中…
            </Button>
          )}
          {!active && !submitting && (
            <>
              {onOpenNightlyRun && (
                <Button size="xs" variant="outline" onClick={onOpenNightlyRun}>
                  予約実行を見る
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={onDismissSummary}>
                閉じる
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
