"use client";

import { useEffect, useState } from "react";

export type GithubApiUsageEndpoint = {
  endpoint: string;
  lastHour: number;
  last24h: number;
};

export type GithubApiUsageFeature = {
  key: string;
  label: string;
  lastHour: number;
  last24h: number;
  endpoints: GithubApiUsageEndpoint[];
};

export type GithubApiUsage = {
  /** 計測を開始した時刻(epoch ms)。アプリの再起動でリセットされる */
  measuringSince: number;
  totalLastHour: number;
  totalLast24h: number;
  features: GithubApiUsageFeature[];
};

export function useGithubApiUsage(enabled: boolean) {
  const [data, setData] = useState<GithubApiUsage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // ダイアログ・画面を開いたタイミングで一度だけ取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。参照先はアプリのメモリ上の集計のみで、
    // GitHub APIは消費しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/github/api-usage")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<GithubApiUsage>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
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
