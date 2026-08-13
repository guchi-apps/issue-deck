"use client";

import { useCallback, useEffect, useState } from "react";

import type { WorkflowTagStatus } from "@/lib/workflow-tags";

type Overview = { latest: string | null; repositories: WorkflowTagStatus[] };

/**
 * 共有ワークフローの参照タグの状況を取得する（#985）。
 *
 * **リポジトリ数ぶんのGitHub API呼び出しになるため、`enabled`が真になったときと、明示的な
 * 再取得のときだけ動かす。** ポーリングはしない。タグを上げるのは日に何度もある操作ではない。
 *
 * 取得の形は`use-claude-usage`に揃えている（ダイアログを開いたときに一度だけ外部システムから
 * 取得する同じ用途のため）。
 */
export function useWorkflowTags(enabled: boolean) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 明示的な再取得のたびに増やして、下のeffectを再実行させる
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // ダイアログを開いたタイミングで一度だけ外部システム（GitHub）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/workflow-tags")
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as Overview;
      })
      .then((json) => {
        if (!cancelled) setOverview(json);
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
  }, [enabled, reloadCount]);

  return { overview, isLoading, error, reload };
}
