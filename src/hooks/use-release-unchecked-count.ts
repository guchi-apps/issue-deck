"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * バックグラウンド再取得間隔（#2951）。`use-repository-release-statuses.ts`の
 * `DEFAULT_INTERVAL_MS`と同じ考え方——リポジトリ数分のGitHub API消費が積み重なるため、
 * 短くしすぎない。
 */
const INTERVAL_MS = 5 * 60 * 1000;

/**
 * 左メニュー「リリース履歴」行・スマホのフッター「リリース」タブに出す未確認件数（#2951）。
 * `enabled`の間は表示直後に1回取得し、以後は`INTERVAL_MS`間隔でバックグラウンド再取得する。
 *
 * **呼び出し側（`NotificationProvider`）は「確認を追う対象」に選んだリポジトリが1件も無い間
 * `enabled`をfalseにする**（`ConnectedRepository.releaseCheckSince`から判定できるため、
 * サーバーへ一切問い合わせない）。対象があっても、リポジトリ数ぶんのGitHub API呼び出しが
 * `INTERVAL_MS`ごとに積み重なるため間隔を短くしすぎない（計画レビューの指摘）。
 */
export function useReleaseUncheckedCount(enabled: boolean) {
  const [count, setCount] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<number | null> => {
    try {
      const res = await fetch("/api/repositories/release-history/unchecked-count");
      if (!res.ok) return null;
      const json = (await res.json()) as { count: number };
      if (mountedRef.current) setCount(json.count);
      return json.count;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    function schedule() {
      if (cancelled) return;
      timerId = setTimeout(tick, INTERVAL_MS);
    }

    async function runOnce() {
      await load();
      schedule();
    }

    function tick() {
      // バックグラウンドタブでは取得しない（復帰後の次の周期で取得される）
      if (document.hidden) {
        timerId = setTimeout(tick, INTERVAL_MS);
        return;
      }
      void runOnce();
    }

    void runOnce();

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [enabled, load]);

  return { count, refetch: load };
}
