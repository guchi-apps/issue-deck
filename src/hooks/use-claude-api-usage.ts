"use client";

import { useEffect, useState } from "react";

import type { ClaudeApiUsageSummary } from "@/lib/claude/api-usage-totals";

export type {
  ClaudeApiTokens,
  ClaudeApiTotals,
  ClaudeApiUsageFeature,
  ClaudeApiUsageModel,
  ClaudeApiUsageSummary,
  ClaudeApiUsageWindows,
} from "@/lib/claude/api-usage-totals";

export function useClaudeApiUsage(enabled: boolean) {
  const [data, setData] = useState<ClaudeApiUsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // 設定の「状態」を開いたタイミングで一度だけ取得する同期処理であり、ループや連鎖的な
    // 再レンダリングは発生しない。参照先はアプリのメモリ上の集計のみで、Anthropic APIは消費しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/claude/api-usage")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<ClaudeApiUsageSummary>;
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
