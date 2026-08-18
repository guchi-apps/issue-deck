"use client";

import { useCallback, useEffect, useRef } from "react";

import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 10_000;

/**
 * Issue一覧をDBから取り直し続ける（叩き先は`GET /api/issues`で、GitHub APIは消費しない）。
 *
 * **`refresh`は「次の周期を待たずに取り直したい」側のためのもの**（#1909）。通知ベルを開いて
 * いる間の自動更新（`notification-state.tsx`）が使う。戻り値は取得できたかどうかで、
 * 呼んだ側が「いつ時点の内容か」を出すのに使う——失敗を成功として数えると、取れていないのに
 * 「たった今更新」と出てしまう。
 */
export function useIssuePolling(onIssues: (issues: Issue[]) => void) {
  const onIssuesRef = useRef(onIssues);
  const mountedRef = useRef(true);

  useEffect(() => {
    onIssuesRef.current = onIssues;
  }, [onIssues]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/issues");
      if (!res.ok) return false;
      const data: { issues: Issue[] } = await res.json();
      if (mountedRef.current) onIssuesRef.current(data.issues);
      return true;
    } catch {
      // ネットワーク瞬断等は次回のポーリングで回復するため無視する
      return false;
    }
  }, []);

  useEffect(() => {
    function poll() {
      if (document.hidden) return;
      void load();
    }

    const intervalId = setInterval(poll, POLL_INTERVAL_MS);

    function handleVisibilityChange() {
      // バックグラウンドタブでは`poll`がno-opのままインターバルだけ進むため、
      // 復帰時に次の周期を待たず即座に最新状態を取得する
      if (!document.hidden) poll();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [load]);

  return { refresh: load };
}
