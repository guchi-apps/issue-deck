"use client";

import { cn } from "@/lib/utils";

/** この割合を下回ったら警告色にする残量(%)。 */
export const LOW_REMAINING_PERCENT = 10;

type UsageMeterProps = {
  /** 「5時間」「週間」「REST」など、枠の名前。 */
  label: string;
  /** 上位に別の見出しがあり、この行が副見出しに当たる場合にtrue。 */
  labelMuted?: boolean;
  /** 使用率(0-100)。バーの塗りの幅になる。 */
  usedPercent: number;
  /** 残量(0-100)。見出し右の数値と警告色の判定に使う。 */
  remainingPercent: number;
  /** 「(5,258 / 5,300)」のように残量へ添える実数（任意）。 */
  remainingSuffix?: string;
  /** 経過時間の割合(0-100)。nullなら目盛りを出さない。 */
  elapsedPercent: number | null;
  /** 「あと51分でリセット」。nullなら出さない。 */
  resetSentence?: string | null;
  /** リセットの絶対時刻。下段が狭いため画面には出さず、ツールチップにだけ置く。 */
  resetTitle?: string | null;
  /** 残量の少なさとは別に警告したい場合（Claudeの`status`が`allowed`以外など）。 */
  isBlocked?: boolean;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * 枠の消費を表すメーター（#1651）。
 *
 * **使用量を左から右へ伸ばし、経過時間は同じバーの上に立つ縦の目盛りで示す。**
 * 以前は残量を描いていたため、消費が進むほどバーが縮み、経過時間も別の細いバーとして
 * 下に並んでいた。1本にまとめると「目盛りより手前で塗りが止まっていれば、時間の進みより
 * 消費が遅い」と一目で分かる。
 *
 * shadcnの`Progress`は縦の目盛りを重ねられず（`overflow-x-hidden`で端が欠ける）、
 * この用途では使わない。
 */
export function UsageMeter({
  label,
  labelMuted = false,
  usedPercent,
  remainingPercent,
  remainingSuffix,
  elapsedPercent,
  resetSentence,
  resetTitle,
  isBlocked = false,
}: UsageMeterProps) {
  const used = clampPercent(usedPercent);
  const elapsed = elapsedPercent === null ? null : clampPercent(elapsedPercent);
  const isDanger = isBlocked || remainingPercent < LOW_REMAINING_PERCENT;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={labelMuted ? "text-muted-foreground" : "font-medium"}>{label}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            isDanger ? "text-destructive" : "text-muted-foreground",
          )}
        >
          残り{" "}
          <span className={cn("font-semibold", !isDanger && "text-foreground")}>
            {Math.round(remainingPercent)}%
          </span>
          {remainingSuffix ? ` ${remainingSuffix}` : ""}
        </span>
      </div>

      <div
        role="meter"
        aria-label={`${label}の使用量`}
        aria-valuenow={Math.round(used)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2 w-full rounded-full bg-muted"
      >
        <div
          data-slot="usage-meter-fill"
          className={cn("h-full rounded-full", isDanger ? "bg-destructive" : "bg-primary")}
          style={{ width: `${used}%` }}
        />
        {elapsed !== null && (
          <div
            data-slot="usage-meter-tick"
            aria-hidden="true"
            // 塗りに重なっても見えるよう、背景色で縁取りする。
            className="absolute -top-[3px] -ml-px h-3.5 w-0.5 rounded-[1px] bg-muted-foreground shadow-[0_0_0_1.5px_var(--background)]"
            style={{ left: `${elapsed}%` }}
          />
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground tabular-nums">
        <span className="flex shrink-0 gap-2">
          <span>使用 {Math.round(used)}%</span>
          {elapsed !== null && <span>経過 {Math.round(elapsed)}%</span>}
        </span>
        {resetSentence && (
          <span className="truncate" title={resetTitle ?? undefined}>
            {resetSentence}
          </span>
        )}
      </div>
    </div>
  );
}
