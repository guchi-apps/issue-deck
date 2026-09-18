"use client";

import { Hourglass, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ScheduledRunQueuedMark } from "@/lib/nightly-run";
import { cn } from "@/lib/utils";

/**
 * 「予約実行に積まれている」ことの目印（#2866・#2995）。一覧の行のチップと、Issue詳細の注釈。
 *
 * **色はindigo。** 既存の意味色と重ねない——amberは確認待ち（人が動くまで進まない）、
 * destructiveは失敗で、どちらも「押さないと進まない」ものに割り当てている。積まれているだけの
 * Issueは待っていれば勝手に走るので、その2つとは別の色にする。**その種類がOFFのときだけamber**
 * ——そのままでは走らず、人が動かないと進まない状態なので、意味の方が一致する。
 *
 * **文言は`selectScheduledRunQueuedMarks`が組み立て済みで渡す。** ここが種類ごとの分岐を持つと、
 * 一覧・詳細・スマホの3か所に同じ分岐が写る。
 *
 * PCとスマホで同じ部品を使う（`nightly-run-panel.tsx`と同じ切り分け）。
 */
function MarkIcon({ className }: { className: string }) {
  return <Hourglass className={className} aria-hidden />;
}

export function NightlyRunChip({
  mark,
  className,
}: {
  mark: ScheduledRunQueuedMark;
  className?: string;
}) {
  return (
    <span
      title={mark.title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        mark.enabled
          ? "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800"
          : "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
        className,
      )}
    >
      <MarkIcon className="size-2.5 shrink-0" />
      {mark.chip}
    </span>
  );
}

/**
 * Issue詳細の注釈（#2866）。**「実装を開始」のすぐ下に置く**——押す直前に読めないと、
 * 「あとで走る予定のものを、いま手で二重に走らせてしまった」に気付けない。
 *
 * 操作は2つだけ持つ。取り消しは「予約実行」画面と同じAPI（`DELETE /api/nightly-run/:id`）で、
 * **設定（有効／無効・時刻）はここに置かない**——設定の正はあちらの画面で、ここは
 * 「予約実行を見る」で送るだけにする。
 */
export function NightlyRunNotice({
  mark,
  onOpenNightlyRun,
  onCancel,
  isCanceling = false,
  className,
}: {
  mark: ScheduledRunQueuedMark;
  /** 「予約実行」画面へ移る。省略すると導線を出さない */
  onOpenNightlyRun?: () => void;
  /** 予定を取り消す（`entryId`を渡す）。省略すると導線を出さない */
  onCancel?: (entryId: string) => void;
  isCanceling?: boolean;
  className?: string;
}) {
  const tone = mark.enabled
    ? "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
    : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";
  const buttonTone = mark.enabled
    ? "border-indigo-300 text-indigo-800 hover:text-indigo-900 dark:border-indigo-700 dark:text-indigo-200 dark:hover:text-indigo-100"
    : "border-amber-400 text-amber-800 hover:text-amber-900 dark:border-amber-700 dark:text-amber-200 dark:hover:text-amber-100";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-xs",
        tone,
        className,
      )}
    >
      <MarkIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-semibold">{mark.title}</p>
        <p className="opacity-90">{mark.detail}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {onOpenNightlyRun && (
          <Button
            variant="outline"
            size="xs"
            className={cn("bg-transparent", buttonTone)}
            onClick={onOpenNightlyRun}
          >
            予約実行を見る
          </Button>
        )}
        {onCancel && (
          <Button
            variant="outline"
            size="xs"
            className={cn("bg-transparent", buttonTone)}
            disabled={isCanceling}
            onClick={() => onCancel(mark.entryId)}
          >
            {isCanceling ? <Loader2 className="animate-spin" /> : <X />}
            予定を取り消す
          </Button>
        )}
      </div>
    </div>
  );
}
