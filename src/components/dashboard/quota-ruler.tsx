"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { nearestOption, stepOption } from "@/lib/quota-ruler";
import { cn } from "@/lib/utils";

/** 静止してから値を確定するまでの時間（ms）。スクロールの途中では保存しない */
const SETTLE_MS = 150;

/**
 * 横スクロールで値を選ぶ目盛り帯（#3821）。中央の針に合わせた目盛りが選ばれた値で、
 * 指（マウス）を離して静止した時点で最寄りの目盛りへ吸着し、`onCommit`で確定する。
 * 左右キーでも1目盛りずつ動かせる（`role="slider"`）。
 */
export function QuotaRuler({
  options,
  value,
  pxPerUnit,
  formatTick,
  formatValue,
  ariaLabel,
  disabled = false,
  onCommit,
}: {
  options: readonly number[];
  value: number;
  /** 値1あたりの横幅（px） */
  pxPerUnit: number;
  formatTick: (value: number) => string;
  formatValue: (value: number) => string;
  ariaLabel: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const scale = (v: number) => v * pxPerUnit;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  const committed = useRef(value);
  // 保存後に外から値が変わったとき（他端末の更新など）は、描画の中で選択中の値を合わせる
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(value);
  }

  const scrollTo = (target: number, smooth: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === "function") el.scrollTo({ left: scale(target), behavior: "smooth" });
    else el.scrollLeft = scale(target);
  };

  // 開いた時点で、いまの値が針の位置に来るようにする
  useLayoutEffect(() => {
    scrollTo(value, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外から値が変わったときは、確定済みの値と針の位置も合わせる
  useEffect(() => {
    committed.current = value;
    scrollTo(value, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const commit = (next: number) => {
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el || disabled) return;
    const next = nearestOption(options, scale, el.scrollLeft);
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      scrollTo(next, true);
      commit(next);
    }, SETTLE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = stepOption(options, draft, event.key === "ArrowLeft" ? -1 : 1);
    setDraft(next);
    scrollTo(next, true);
    commit(next);
  };

  const min = options[0];
  const max = options[options.length - 1];

  return (
    <div className="relative rounded-md border border-primary/30 bg-primary/5 py-1.5">
      <div
        ref={scrollerRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={draft}
        aria-valuetext={formatValue(draft)}
        aria-disabled={disabled}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        className={cn(
          "overflow-x-auto overscroll-x-contain outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "focus-visible:ring-2 focus-visible:ring-ring",
          disabled ? "opacity-60" : "cursor-grab",
        )}
        style={{ touchAction: "pan-x" }}
      >
        {/* 左右の余白を半幅にして、どの目盛りも中央の針に合わせられるようにする */}
        <div className="relative h-9" style={{ marginInline: "50%", width: scale(max) }}>
          {options.map((option) => (
            <span
              key={option}
              className={cn(
                "absolute top-0 flex -translate-x-1/2 flex-col items-center font-mono text-[11px] tabular-nums",
                option === draft ? "font-semibold text-primary" : "text-muted-foreground",
              )}
              style={{ left: scale(option) }}
            >
              <i className="mb-0.5 block h-3 w-px bg-current" aria-hidden />
              {formatTick(option)}
            </span>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded bg-primary" aria-hidden />
    </div>
  );
}
