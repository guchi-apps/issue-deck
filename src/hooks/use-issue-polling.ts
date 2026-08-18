"use client";

import { useCallback, useEffect, useRef } from "react";

import { LIST_POLL_INTERVAL_MS } from "@/lib/auto-refresh";
import type { Issue } from "@/types/issue";

export type IssuePollingHandle = {
  /**
   * いますぐ取り直す。一覧を下へ引っ張ったとき（#1893）や、通知ベルを開いている間の
   * 自動更新（`notification-state.tsx`、#1909）が使う。**ポーリングと違い
   * `document.hidden`では止めない**——見ていない画面のための取得ではないため。
   * 戻り値は取得できたかどうかで、呼んだ側が「いつ時点の内容か」を出すのに使う——
   * 失敗を成功として数えると、取れていないのに「たった今更新」と出てしまう。
   */
  refresh: () => Promise<boolean>;
};

/**
 * Issue一覧をDBから取り直し続ける（叩き先は`GET /api/issues`で、GitHub APIは消費しない）。
 */
export function useIssuePolling(onIssues: (issues: Issue[]) => void): IssuePollingHandle {
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

  const refresh = useCallback(async (): Promise<boolean> => {
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
      void refresh();
    }

    const intervalId = setInterval(poll, LIST_POLL_INTERVAL_MS);

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
  }, [refresh]);

  return { refresh };
}
