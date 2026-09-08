"use client";

import { useCallback, useEffect, useState } from "react";

import type { KnowledgeBoardData } from "@/lib/knowledge-board";

type UseKnowledgeBoardResult = {
  data: KnowledgeBoardData | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * 「共通知識」画面（#2912）のデータ取得。
 *
 * **自動更新は持たない**（`use-release-history.ts`と同じ）。材料が変わるのは共有知識への
 * Pull Requestがマージされたときと、格上げ判定が走るとき（毎日05:00 JST）だけで、どちらも
 * 日単位でしか動かない。更新ボタンはサーバー側のキャッシュも捨てさせる（`?refresh=1`）。
 *
 * `enabled`がfalseの間は取得しない（ペインを開いていないときにフェッチしない）。
 */
export function useKnowledgeBoard(enabled: boolean): UseKnowledgeBoardResult {
  const [data, setData] = useState<KnowledgeBoardData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    // 初回は普通に取り（サーバー側のキャッシュに乗る）、更新ボタンからだけ取り直させる。
    const url = reloadKey === 0 ? "/api/knowledge" : "/api/knowledge?refresh=1";

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as KnowledgeBoardData;
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
  }, [enabled, reloadKey]);

  return { data, isLoading, error, refresh };
}
