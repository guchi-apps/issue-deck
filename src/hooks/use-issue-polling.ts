"use client";

import { useEffect, useRef } from "react";

import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 20_000;

export function useIssuePolling(onIssues: (issues: Issue[]) => void) {
  const onIssuesRef = useRef(onIssues);

  useEffect(() => {
    onIssuesRef.current = onIssues;
  }, [onIssues]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/issues");
        if (!res.ok) return;
        const data: { issues: Issue[] } = await res.json();
        if (!cancelled) onIssuesRef.current(data.issues);
      } catch {
        // ネットワーク瞬断等は次回のポーリングで回復するため無視する
      }
    }

    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);
}
