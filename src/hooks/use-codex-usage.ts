"use client";

import { useEffect, useState } from "react";

import type { CodexUsage } from "@/lib/dispatch/codex-usage";

export function useCodexUsage(enabled: boolean) {
  const [data, setData] = useState<CodexUsage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    setNotConfigured(false);

    fetch("/api/codex/usage")
      .then(async (res) => {
        if (res.status === 501) {
          if (!cancelled) setNotConfigured(true);
          return null;
        }
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as CodexUsage;
      })
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { data, isLoading, error, notConfigured };
}
