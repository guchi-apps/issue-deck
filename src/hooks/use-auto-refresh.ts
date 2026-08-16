"use client";

import { useEffect, type RefObject } from "react";

import type { AutoRefreshIntervalMs } from "@/lib/auto-refresh";

/**
 * 一定間隔で再取得を回す（#1531・#1767）。取得そのものは呼び出し側が持ち、
 * ここは「いつ呼ぶか」だけを持つ。
 *
 * 渡すのは取得関数そのものではなく**refに預けた関数**。取得のeffectの中で作った関数を
 * ここへ渡すことで、ポーリングが取得effectを再実行させずに（＝`isLoading`を立て直さずに）
 * 呼べる。
 *
 * - **裏に回っているタブでは取りに行かない**（Page Visibility API）。見ていない画面のために
 *   GitHub APIを消費しない。前面へ戻った時点では次の周期を待たずに取り直す——
 *   バックグラウンドの間もインターバルだけは進むため、待たせると最大で1周期ぶん古い内容が
 *   残る。
 * - **有効になった直後にも1回取る。** 画面を開いた（あるいは間隔を選んだ）時点の内容が
 *   最長1周期ぶん古いままにならないようにするため。取得が飛んでいる間の重複は
 *   呼び出し側の`inFlight`ガードが弾く。
 */
export function useAutoRefresh(
  intervalMs: AutoRefreshIntervalMs,
  loadRef: RefObject<(() => void | Promise<void>) | null>,
): void {
  useEffect(() => {
    if (intervalMs === null) return;

    function poll() {
      if (document.hidden) return;
      void loadRef.current?.();
    }

    poll();
    const intervalId = setInterval(poll, intervalMs);

    function handleVisibilityChange() {
      if (!document.hidden) poll();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs, loadRef]);
}
