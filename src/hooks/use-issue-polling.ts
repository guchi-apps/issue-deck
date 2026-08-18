"use client";

import { useCallback, useEffect, useRef } from "react";

import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 10_000;

export type IssuePollingHandle = {
  /**
   * いますぐ取り直す（#1893）。一覧を下へ引っ張ったときのように、ユーザーが明示的に
   * 求めたときだけ呼ぶ。**ポーリングと違い`document.hidden`では止めない**——
   * 見ていない画面のための取得ではないため。
   */
  refresh: () => Promise<void>;
};

export function useIssuePolling(onIssues: (issues: Issue[]) => void): IssuePollingHandle {
  const onIssuesRef = useRef(onIssues);
  const cancelledRef = useRef(false);

  useEffect(() => {
    onIssuesRef.current = onIssues;
  }, [onIssues]);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/issues");
      if (!res.ok) return;
      const data: { issues: Issue[] } = await res.json();
      if (!cancelledRef.current) onIssuesRef.current(data.issues);
    } catch {
      // ネットワーク瞬断等は次回のポーリングで回復するため無視する
    }
  }, []);

  useEffect(() => {
    function poll() {
      if (document.hidden) return;
      void refresh();
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
  }, [refresh]);

  return { refresh };
}
