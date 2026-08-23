"use client";

import { useEffect, useState } from "react";

import type { ActionsUsageEntry } from "@/lib/github/actions-billing";

export type {
  ActionsUsage,
  ActionsUsageEntry,
  ActionsUsagePeriod,
  ActionsUsageRepository,
} from "@/lib/github/actions-billing";

export function useGithubActionsUsage(enabled: boolean) {
  const [data, setData] = useState<ActionsUsageEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // 設定の「状態」を開いたタイミングで一度だけ外部システム（GitHub API）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/github/actions-usage")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ installations: ActionsUsageEntry[] }>;
      })
      .then((json) => {
        if (!cancelled) setData(json.installations);
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

  return { data, isLoading, error };
}
