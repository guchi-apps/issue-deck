"use client";

import { useCallback, useEffect, useState } from "react";

import type { SecretSyncRunView } from "@/lib/secrets-sync";

export type SecretsSyncRepository = {
  fullName: string;
  latestRun: SecretSyncRunView | null;
};

/** 実行中のあいだの再取得間隔。Actionsの起動〜完了は1分前後 */
const RUNNING_POLL_INTERVAL_MS = 5_000;

/**
 * シークレット同期の状況を取得する（#1309）。
 *
 * 取得先はissue-deck自身のDB（GitHubは叩かない）。**実行中の行がある間だけポーリングする。**
 * 押してからActionsが起動して結果が返るまで数十秒あり、その間の状態が見えないと
 * 「押しても何も起きていない」ようにしか見えない（`use-dispatch-state.ts`と同じ理由）。
 */
export function useSecretsSync(enabled: boolean) {
  const [repositories, setRepositories] = useState<SecretsSyncRepository[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  const isRunning = repositories.some((repository) => repository.latestRun?.status === "QUEUED");

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/secrets-sync");
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const json: { repositories: SecretsSyncRepository[] } = await res.json();
        if (!cancelled) {
          setRepositories(json.repositories);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // ダイアログを開いたタイミングでの一度きりの取得と、実行中のポーリング。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    void load();

    if (!isRunning) return () => {
      cancelled = true;
    };

    const timer = setInterval(() => void load(), RUNNING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, reloadCount, isRunning]);

  return { repositories, isLoading, error, reload, setError };
}
