"use client";

import { useRef, useState } from "react";
import type { CSSProperties, TouchEvent } from "react";

import { BACK_EDGE_RATIO, isInsideHorizontalScroller } from "@/hooks/use-swipe-back";

export const SWIPE_THRESHOLD_PX = 80;
const DIRECTION_LOCK_PX = 10;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;

export type SwipeFilterDirection = "prev" | "next";

type SwipeState = {
  startX: number;
  startY: number;
  /** 開始位置が戻るジェスチャー（useSwipeBack）の判定領域内かどうか */
  startedInBackEdge: boolean;
  tracking: boolean;
  locked: "horizontal" | "vertical" | null;
  deltaX: number;
};

// スマホのIssue一覧で、画面を左右にスワイプしてビュータブ（navViews）を
// 切り替えるフック。左スワイプ（次のビューへ）は開始位置によらず常に有効だが、
// 右スワイプ（前のビューへ）は useSwipeBack の戻るジェスチャーと領域が重なるため、
// 画面左端寄り（BACK_EDGE_RATIO）から始まった場合は戻る側に譲り、何もしない。
export function useSwipeFilterView(onSwipe: (direction: SwipeFilterDirection) => void) {
  const stateRef = useRef<SwipeState | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  function onTouchStart(e: TouchEvent<HTMLElement>) {
    const touch = e.touches[0];
    if (!touch) return;

    if (isInsideHorizontalScroller(e.target, e.currentTarget)) {
      stateRef.current = null;
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    stateRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startedInBackEdge: touch.clientX - rect.left < rect.width * BACK_EDGE_RATIO,
      tracking: true,
      locked: null,
      deltaX: 0,
    };
  }

  function onTouchMove(e: TouchEvent<HTMLElement>) {
    const state = stateRef.current;
    const touch = e.touches[0];
    if (!state || !state.tracking || !touch) return;

    const deltaX = touch.clientX - state.startX;
    const deltaY = touch.clientY - state.startY;

    if (state.locked === null) {
      if (Math.abs(deltaX) < DIRECTION_LOCK_PX && Math.abs(deltaY) < DIRECTION_LOCK_PX) {
        return;
      }
      state.locked =
        Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO ? "horizontal" : "vertical";
      if (state.locked === "vertical") {
        state.tracking = false;
        return;
      }
      setIsDragging(true);
    }

    state.deltaX = deltaX;
    // 戻るジェスチャーの判定領域内から始まった右方向の動きは、useSwipeBack側の
    // ドラッグ表示に譲る（両方の見た目が重なって二重に動いて見えるのを防ぐ）。
    setDragX(deltaX > 0 && state.startedInBackEdge ? 0 : deltaX);
  }

  function onTouchEnd() {
    const state = stateRef.current;
    stateRef.current = null;
    setIsDragging(false);
    if (!state || !state.tracking || state.locked !== "horizontal") {
      setDragX(0);
      return;
    }

    if (state.deltaX <= -SWIPE_THRESHOLD_PX) {
      onSwipe("next");
      setDragX(0);
      return;
    }
    if (state.deltaX >= SWIPE_THRESHOLD_PX && !state.startedInBackEdge) {
      onSwipe("prev");
      setDragX(0);
      return;
    }
    setDragX(0);
  }

  function onTouchCancel() {
    stateRef.current = null;
    setIsDragging(false);
    setDragX(0);
  }

  // ドラッグ中は指の動きにそのまま追従させ、指を離した後は0へ戻すアニメーションを
  // かける。スワイプが成立した場合は切り替え後の新しいビューの内容が0の位置へ
  // 滑り込んでくるように見え、閾値未達の場合は元の内容がそのまま戻る（#734）。
  const style: CSSProperties = {
    transform: dragX !== 0 ? `translateX(${dragX}px)` : undefined,
    transition: isDragging ? "none" : "transform 0.2s ease-out",
  };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, style, dragX, isDragging };
}
