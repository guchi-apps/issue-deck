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
  /** `GITHUB_BILLING_TOKEN`が未設定。エラーではなく「この表示だけ無効」として扱う */
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // 設定の「状態」を開いたタイミングで一度だけ外部システム（GitHub API）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    setNotConfigured(false);

    fetch("/api/github/actions-usage")
      .then(async (res) => {
        if (res.status === 501) {
          if (!cancelled) setNotConfigured(true);
          return null;
        }
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as { installations: ActionsUsageEntry[] };
      })
      .then((json) => {
        if (!cancelled && json) setData(json.installations);
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
