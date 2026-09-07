"use client";

import { Loader2, Moon, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  describeNightlyRunMarkChip,
  describeNightlyRunMarkDetail,
  describeNightlyRunMarkTitle,
  type NightlyRunQueuedMark,
} from "@/lib/nightly-run";
import { cn } from "@/lib/utils";

/**
 * 「今夜の夜間実行に積まれている」ことの目印（#2866）。一覧の行のチップと、Issue詳細の注釈。
 *
 * **色はindigo。** 既存の意味色と重ねない——amberは確認待ち（人が動くまで進まない）、
 * destructiveは失敗で、どちらも「押さないと進まない」ものに割り当てている。積まれているだけの
 * Issueは待っていれば勝手に走るので、その2つとは別の色にする。**夜間実行がOFFのときだけamber**
 * ——そのままでは走らず、人が動かないと進まない状態なので、意味の方が一致する。
 *
 * PCとスマホで同じ部品を使う（`nightly-run-panel.tsx`と同じ切り分け）。
 */
export function NightlyRunChip({
  mark,
  className,
}: {
  mark: NightlyRunQueuedMark;
  className?: string;
}) {
  return (
    <span
      title={describeNightlyRunMarkTitle(mark)}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
        mark.enabled
          ? "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800"
          : "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
        className,
      )}
    >
      <Moon className="size-2.5 shrink-0" aria-hidden />
      {describeNightlyRunMarkChip(mark)}
    </span>
  );
}

/**
 * Issue詳細の注釈（#2866）。**「実装を開始」のすぐ下に置く**——押す直前に読めないと、
 * 「今夜走る予定のものを、いま手で二重に走らせてしまった」に気付けない。
 *
 * 操作は2つだけ持つ。取り消しは「夜間実行」画面と同じAPI（`DELETE /api/nightly-run/:id`）で、
 * **設定（有効／無効・開始時刻）はここに置かない**——設定の正はあちらの画面で、ここは
 * 「夜間実行を見る」で送るだけにする。
 */
export function NightlyRunNotice({
  mark,
  onOpenNightlyRun,
  onCancel,
  isCanceling = false,
  className,
}: {
  mark: NightlyRunQueuedMark;
  /** 「夜間実行」画面へ移る。省略すると導線を出さない */
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
      <Moon className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-semibold">{describeNightlyRunMarkTitle(mark)}</p>
        <p className="opacity-90">{describeNightlyRunMarkDetail(mark)}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {onOpenNightlyRun && (
          <Button
            variant="outline"
            size="xs"
            className={cn("bg-transparent", buttonTone)}
            onClick={onOpenNightlyRun}
          >
            夜間実行を見る
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
