"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** "main": develop→mainのPRがマージ待ち。"develop": バンプPRがCI通過後もマージ待ち（#979） */
export type ReleaseMergeTarget = "main" | "develop";

export type ReleasePendingMerge = {
  repoFullName: string;
  mergeTarget: ReleaseMergeTarget;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
};

/**
 * ヘッダーの常時表示アイコンでのバックグラウンド再取得間隔（#979）。`useReleaseStatus`のような
 * 常時ポーリングはリポジトリ数分のAPI消費が積み重なるため、短くしすぎない。
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 全リポジトリ分のマージ待ち状態（developへのマージ待ち／mainへのマージ待ち）を取得する。
 * `enabled`の間は表示直後に1回取得し、以後`intervalMs`間隔でバックグラウンド再取得する。
 * `refetch`はポップオーバーを開いたときなどの即時再取得に使う。
 */
export function useReleasePendingMerges(enabled: boolean, intervalMs: number = DEFAULT_INTERVAL_MS) {
  const [data, setData] = useState<ReleasePendingMerge[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/repositories/release-pending-merges");
      if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
      const json = (await res.json()) as { pendingMerges: ReleasePendingMerge[] };
      if (mountedRef.current) setData(json.pendingMerges);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timerId = setInterval(() => {
      // バックグラウンドタブでは取得しない（復帰後の次の周期で取得される）
      if (!document.hidden) void load();
    }, intervalMs);

    return () => clearInterval(timerId);
  }, [enabled, intervalMs, load]);

  return { data, isLoading, error, refetch: load };
}
