"use client";

import { useCallback, useEffect, useState } from "react";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";

type UseReleaseHistoryResult = {
  entries: ReleaseHistoryItem[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * 「リリース履歴」画面（#2726）のデータ取得。
 *
 * **自動更新は持たない。** リリースは1日に何度も増えるものではないため、`use-session-usage.ts`
 * と同じく画面を開いたときと更新ボタンを押したときにだけ取得する。
 *
 * `enabled`がfalseの間は取得しない（ペインを開いていないときにフェッチしない）。
 */
export function useReleaseHistory(enabled: boolean): UseReleaseHistoryResult {
  const [entries, setEntries] = useState<ReleaseHistoryItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/repositories/release-history", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as { entries: ReleaseHistoryItem[] };
      })
      .then((json) => {
        if (!cancelled) setEntries(json.entries);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, reloadKey]);

  return { entries, isLoading, error, refresh };
}
