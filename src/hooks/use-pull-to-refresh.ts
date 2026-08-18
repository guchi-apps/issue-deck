"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  PULL_SPINNER_PX,
  PULL_THRESHOLD_PX,
  remainingRefreshingMs,
  resolvePullArrowDegrees,
  resolvePullDistance,
  resolvePullLabel,
  resolvePullPhase,
  type PullPhase,
} from "@/lib/pull-to-refresh";

/** 方向を決めるまでに必要な移動量。`use-swipe-back.ts`と同じ値にそろえる */
const DIRECTION_LOCK_PX = 10;
/** 横方向と判定するための優位さ。`use-swipe-back.ts`・`use-swipe-filter-view.ts`と同じ */
const HORIZONTAL_DOMINANCE_RATIO = 1.5;

type PullState = {
  startX: number;
  startY: number;
  tracking: boolean;
  locked: "horizontal" | "vertical" | null;
  distance: number;
};

export type PullToRefreshHandle = {
  /** 一覧を下げる量（px） */
  distance: number;
  phase: PullPhase;
  /** インジケーターに出す文言。`idle`ではnull */
  label: string | null;
  /** 矢印の回転角。しきい値でちょうど1周する */
  arrowDegrees: number;
  /** 指を離した後の戻りだけアニメーションさせるためのフラグ */
  isDragging: boolean;
};

type UsePullToRefreshParams = {
  /**
   * タッチを受ける要素。**スクロール領域そのものではなく、それを含む枠に付ける。**
   * 一覧は0件のとき`<ul>`ごと消えるため、スクロール領域に直接付けると
   * 「該当するIssueがありません」の画面で引っ張れなくなる。
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * スクロール位置を見る要素。先頭（`scrollTop === 0`）にいるときだけ引っ張りを受け付ける。
   * 無い（0件で`<ul>`が描かれていない）ときは先頭とみなす。
   */
  scrollRef: RefObject<HTMLElement | null>;
  /** 更新の実行。渡さない場合はこのフックは何もしない（PCの一覧） */
  onRefresh?: () => Promise<unknown> | void;
};

/**
 * スクロール領域を先頭から下へ引っ張って更新するフック（#1893）。
 *
 * **Reactの`onTouchMove`ではなく、`{ passive: false }`のネイティブリスナーを直接張る。**
 * Reactはルートで`touchstart`/`touchmove`をpassiveとして登録するため、Reactのハンドラから
 * `preventDefault()`を呼んでも効かず、iOSのラバーバンドを抑えられない。
 *
 * **`preventDefault()`するのは「縦方向 かつ 下向き」に動いている間だけ。** 方向判定
 * （`use-swipe-back.ts`と同じ式）は横が明確に優位でない限り縦と見なすため、条件を
 * 「縦と判定した」だけにすると、一覧の先頭で指を上へ動かして読み進める操作まで
 * ネイティブのスクロールごと止まってしまう。上向きに転じた時点でそのタッチは手放す。
 */
export function usePullToRefresh({
  containerRef,
  scrollRef,
  onRefresh,
}: UsePullToRefreshParams): PullToRefreshHandle {
  const stateRef = useRef<PullState | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const [distance, setDistance] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // イベントハンドラの中から今の状態を見るためのミラー。リスナーは張り替えたくないので
  // 依存に入れず、refで読む
  const isRefreshingRef = useRef(false);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const enabled = Boolean(onRefresh);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    let cancelled = false;

    function reset() {
      stateRef.current = null;
      setIsDragging(false);
      setDistance(0);
    }

    async function runRefresh() {
      isRefreshingRef.current = true;
      setIsRefreshing(true);
      setIsDragging(false);
      setDistance(PULL_SPINNER_PX);
      const startedAt = Date.now();
      try {
        await onRefreshRef.current?.();
      } catch {
        // 通信の瞬断などは知らせない。10秒ごとの自動更新（`use-issue-polling.ts`）が
        // 次の周回で追いつくため、指を離しただけの操作に警告を出す価値がない
      }
      // 取得が速すぎると回転が1周もせずに消え、点滅にしか見えないため下限まで保つ
      const remaining = remainingRefreshingMs(Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      isRefreshingRef.current = false;
      if (cancelled) return;
      setIsRefreshing(false);
      setDistance(0);
    }

    function handleTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      // 更新中の二重起動を防ぐ。先頭にいないときは通常のスクロールのままにする
      if (isRefreshingRef.current || (scrollRef.current?.scrollTop ?? 0) > 0) {
        stateRef.current = null;
        return;
      }
      stateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        tracking: true,
        locked: null,
        distance: 0,
      };
    }

    function handleTouchMove(event: TouchEvent) {
      const state = stateRef.current;
      const touch = event.touches[0];
      if (!state || !state.tracking || !touch) return;

      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;

      if (state.locked === null) {
        if (Math.abs(deltaX) < DIRECTION_LOCK_PX && Math.abs(deltaY) < DIRECTION_LOCK_PX) {
          return;
        }
        state.locked =
          Math.abs(deltaX) > Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO
            ? "horizontal"
            : "vertical";
        // 横方向は戻る（`use-swipe-back.ts`）とビュー切り替え（`use-swipe-filter-view.ts`）の担当
        if (state.locked === "horizontal") {
          state.tracking = false;
          return;
        }
      }

      // 上向きへ転じたら、そのタッチは通常のスクロールへ返す
      if (deltaY <= 0) {
        state.tracking = false;
        state.distance = 0;
        setIsDragging(false);
        setDistance(0);
        return;
      }

      // ここまで来たときだけ既定動作を止める（iOSのラバーバンドを抑える）
      if (event.cancelable) event.preventDefault();
      state.distance = resolvePullDistance(deltaY);
      setIsDragging(true);
      setDistance(state.distance);
    }

    function handleTouchEnd() {
      const state = stateRef.current;
      stateRef.current = null;
      setIsDragging(false);
      if (state?.tracking && state.distance >= PULL_THRESHOLD_PX) {
        void runRefresh();
        return;
      }
      setDistance(0);
    }

    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", reset);

    return () => {
      cancelled = true;
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", reset);
    };
  }, [containerRef, scrollRef, enabled]);

  const phase = resolvePullPhase(distance, isRefreshing);

  return {
    distance,
    phase,
    label: resolvePullLabel(phase),
    arrowDegrees: resolvePullArrowDegrees(distance),
    isDragging,
  };
}
