"use client";

import { useCallback, useEffect, useState } from "react";

import type { FineGrainedToken } from "@/types/fine-grained-token";

export function useFineGrainedTokens(enabled: boolean) {
  const [data, setData] = useState<FineGrainedToken[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // 設定画面を開いたタイミング・再取得要求のタイミングで取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/settings/fine-grained-tokens")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ fineGrainedTokens: FineGrainedToken[] }>;
      })
      .then((json) => {
        if (!cancelled) setData(json.fineGrainedTokens);
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
  }, [enabled, reloadKey]);

  const refetch = useCallback(() => setReloadKey((key) => key + 1), []);

  return { data, isLoading, error, refetch };
}
