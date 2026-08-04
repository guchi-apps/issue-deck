"use client";

import { useEffect, useState } from "react";

export type ClaudeRateLimit = {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

export function useClaudeRateLimit(enabled: boolean) {
  const [data, setData] = useState<ClaudeRateLimit | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // ダイアログを開いたタイミングで一度だけ外部システム（Anthropic API）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    setNotConfigured(false);

    fetch("/api/claude/rate-limit")
      .then(async (res) => {
        if (res.status === 501) {
          if (!cancelled) setNotConfigured(true);
          return null;
        }
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as ClaudeRateLimit;
      })
      .then((json) => {
        if (!cancelled && json) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
