"use client";

import { useEffect, useState } from "react";

/** レート制限の枠1つぶん。RESTとGraphQLは別枠のため複数返る（#1040） */
export type RateLimitResource = {
  key: string;
  label: string;
  limit: number;
  remaining: number;
  used: number;
  reset: number;
};

export type InstallationRateLimit = {
  accountLogin: string;
  resources: RateLimitResource[];
};

export function useGithubRateLimit(enabled: boolean) {
  const [data, setData] = useState<InstallationRateLimit[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // ダイアログを開いたタイミングで一度だけ外部システム（GitHub API）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/github/rate-limit")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ installations: InstallationRateLimit[] }>;
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
