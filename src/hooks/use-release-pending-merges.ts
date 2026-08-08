"use client";

import { useEffect, useState } from "react";

export type ReleasePendingMerge = {
  repoFullName: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
};

/**
 * ダイアログを開いたときに1回だけ全リポジトリ分のmainマージ待ち状態を取得する。
 * `useReleaseStatus`のような常時ポーリングはリポジトリ数分のAPI消費が積み重なるため採用しない。
 */
export function useReleasePendingMerges(enabled: boolean) {
  const [data, setData] = useState<ReleasePendingMerge[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/repositories/release-pending-merges")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ pendingMerges: ReleasePendingMerge[] }>;
      })
      .then((json) => {
        if (!cancelled) setData(json.pendingMerges);
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
