"use client";

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { usePersistedState } from "@/hooks/use-persisted-state";

type UseResizableWidthOptions = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  // ドラッグハンドルがカラムのどちら側にあるか。"right"はハンドルがカラム右端にあり
  // 右方向へのドラッグで幅が広がる（例: サイドバーやIssue一覧）、"left"はハンドルが
  // カラム左端にあり左方向へのドラッグで幅が広がる（例: プロパティパネル）。
  handleSide: "left" | "right";
};

export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  handleSide,
}: UseResizableWidthOptions) {
  const [width, setWidth] = usePersistedState(storageKey, defaultWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, value)),
    [minWidth, maxWidth],
  );

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!dragState.current) return;
      const delta = event.clientX - dragState.current.startX;
      const signedDelta = handleSide === "right" ? delta : -delta;
      setWidth(clamp(dragState.current.startWidth + signedDelta));
    }

    function handlePointerUp() {
      dragState.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [clamp, handleSide, setWidth]);

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    dragState.current = { startX: event.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return { width: clamp(width), handleDragStart };
}
