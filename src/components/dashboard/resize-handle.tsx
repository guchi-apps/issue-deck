"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

type ResizeHandleProps = {
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  // 表示/非表示のブレークポイントは呼び出し側のカラムに合わせて指定する
  // （例: "hidden md:block" / "hidden xl:block"）
  className: string;
};

export function ResizeHandle({ onDragStart, className }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onDragStart}
      className={cn("group relative w-1.5 shrink-0 cursor-col-resize touch-none", className)}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-active:bg-primary" />
    </div>
  );
}
