"use client";

import { useRef, useState } from "react";
import type { CSSProperties, TouchEvent } from "react";

const SWIPE_THRESHOLD_PX = 80;
const DIRECTION_LOCK_PX = 10;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;
/**
 * 戻るジェスチャーの判定領域（画面幅に対する左端からの比率）。
 * スマホのIssue一覧ではこの領域外の右スワイプをフィルタービュー切り替えに
 * 割り当てるため、use-swipe-filter-view.tsからも同じ比率を参照する（#706）。
 */
export const BACK_EDGE_RATIO = 1 / 5;

type SwipeState = {
  startX: number;
  startY: number;
  tracking: boolean;
  locked: "horizontal" | "vertical" | null;
  deltaX: number;
};

// 横スクロール可能な要素（コード表示・ステップ表示など）の内側から始まった
// タッチは、そちらのスクロール操作を優先させるため戻る判定の対象外にする。
export function isInsideHorizontalScroller(target: EventTarget | null, container: Element): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== container) {
    if (el.scrollWidth > el.clientWidth) {
      const overflowX = window.getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

// 画面の左端寄り（BACK_EDGE_RATIO）の領域から指で右にスワイプすると
// onBack を呼び出すフック。縦スクロールや横スクロール要素の操作は妨げないよう、
// 最初の移動量からジェスチャーの方向を判定し、横方向優位のときのみ戻る操作として扱う。
// 領域外の右スワイプはuseSwipeFilterView側でフィルタービュー切り替えに使う（#706）。
export function useSwipeBack(onBack: () => void) {
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
    const isInBackEdge = touch.clientX - rect.left < rect.width * BACK_EDGE_RATIO;
    stateRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      tracking: isInBackEdge,
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
    setDragX(Math.max(0, deltaX));
  }

  function onTouchEnd() {
    const state = stateRef.current;
    stateRef.current = null;
    setIsDragging(false);
    if (!state || !state.tracking || state.locked !== "horizontal") {
      setDragX(0);
      return;
    }
    if (state.deltaX > SWIPE_THRESHOLD_PX) {
      // 戻る操作を確定させる。この画面はここで表示されなくなるので、
      // 追従していた位置を0に戻すアニメーションは行わない。
      onBack();
      return;
    }
    setDragX(0);
  }

  function onTouchCancel() {
    stateRef.current = null;
    setIsDragging(false);
    setDragX(0);
  }

  // ドラッグ中は指の動きにそのまま追従させ、指を離した後の戻り（スワイプ未達時）
  // だけアニメーションさせる。
  const style: CSSProperties = {
    transform: dragX > 0 ? `translateX(${dragX}px)` : undefined,
    transition: isDragging ? "none" : "transform 0.2s ease-out",
  };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, style };
}
