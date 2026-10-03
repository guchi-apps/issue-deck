"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { optionFromRatio, stepOption } from "@/lib/quota-ruler";
import { cn } from "@/lib/utils";

/**
 * バーの上に重ねる、ドラッグで値を選ぶつまみ（#3841）。親の`relative`なバーの右端が値0、左端が`maxValue`で、
 * 値は選択肢のどれかへ吸着する。離した時点（キー操作は1回ごと）で`onCommit`し、ドラッグ中は値の吹き出しを出す。
 * マウス・タッチ・ペンはpointer eventsで同じに扱い、キーは左右で1目盛り・Home/Endで両端。
 * 左へ動かすほど値が大きくなるので、キーも見た目に合わせて左が増える。
 */
export function BarHandle({
  options,
  value,
  maxValue,
  formatValue,
  ariaLabel,
  tone,
  disabled = false,
  onCommit,
}: {
  options: readonly number[];
  value: number;
  /** バーの左端にあたる値（右端は0） */
  maxValue: number;
  formatValue: (value: number) => string;
  ariaLabel: string;
  tone: "floor" | "launch";
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const min = options[0];
  const max = options[options.length - 1];

  const valueAt = (event: PointerEvent<HTMLDivElement>): number | null => {
    const bar = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bar || bar.width <= 0) return null;
    return optionFromRatio(options, (bar.right - event.clientX) / bar.width, maxValue);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft(valueAt(event) ?? value);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draft === null) return;
    const next = valueAt(event);
    if (next !== null) setDraft(next);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (draft === null) return;
    const next = commit ? (valueAt(event) ?? draft) : value;
    setDraft(null);
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = stepOption(options, value, 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = stepOption(options, value, -1);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    if (next !== value) onCommit(next);
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={formatValue(shown)}
      aria-disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute top-1/2 grid h-11 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center outline-none",
        disabled ? "opacity-60" : "cursor-ew-resize",
      )}
      style={{ left: `${(1 - shown / maxValue) * 100}%`, touchAction: "none" }}
    >
      <i
        aria-hidden
        className={cn(
          "block h-6 w-1.5 rounded bg-amber-500 shadow-[0_0_0_3px_var(--background),0_1px_4px_rgb(0_0_0/0.3)]",
          tone === "launch" && "bg-primary",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2",
        )}
      />
      {draft !== null && (
        <span className="pointer-events-none absolute bottom-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-semibold text-background">
          {formatValue(draft)}
        </span>
      )}
    </div>
  );
}
