"use client";

import { useCallback, useEffect, useState } from "react";

import type { ClaudeUsage } from "@/lib/claude/usage";
import type { CodexUsage } from "@/lib/dispatch/codex-usage";
import type { SessionUsageAgent } from "@/lib/dispatch/session-usage";
import type { SessionUsageSummary } from "@/lib/session-usage-view";

export type SessionUsageResponse = SessionUsageSummary & {
  agent: SessionUsageAgent;
  /** プラン枠のメーター。取得できなければnull */
  planUsage: ClaudeUsage | CodexUsage | null;
  /** `CLAUDE_CODE_OAUTH_TOKEN`が未設定。エラーではないので理由を1行だけ出す */
  planNotConfigured: boolean;
};

type UseSessionUsageResult = {
  data: SessionUsageResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * 「AI使用量」画面（#2504）のデータ取得。
 *
 * **自動更新は持たない。** 材料はサブPCのpollerが5分ごとに押し込む記録で、秒単位で動くものが
 * 無い。周期で取り直すとプラン枠の取得（`lib/claude/usage.ts`のプローブ）がそのぶん走る。
 * 更新したいときは画面の更新ボタンを押す。
 *
 * `enabled`がfalseの間は取得しない。**一度取得した内容は保持する**（画面を出入りするたびに
 * 取り直さない。`use-branch-flow.ts`と同じ扱い）。
 */
export function useSessionUsage(
  enabled: boolean,
  days: number,
  agent: SessionUsageAgent,
): UseSessionUsageResult {
  const [data, setData] = useState<SessionUsageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    // 画面を開いた・期間を変えた・更新を押したときにだけ走る取得で、連鎖的な再レンダリングは
    // 起きない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setData(null);
    setError(null);

    fetch(`/api/session-usage?days=${days}&agent=${agent}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as SessionUsageResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
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
  }, [enabled, days, agent, reloadKey]);

  return { data, isLoading, error, refresh };
}
