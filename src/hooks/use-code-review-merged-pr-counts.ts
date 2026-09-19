"use client";

import { useEffect, useState } from "react";

/**
 * リポジトリ別の枠（#3092）に出す「入ったPRの件数」を、期間ごとにまとめて取る。
 *
 * **ポーリングはしない**（`useCodeReviewReports`と同じ）。期間の組（`rangeKeys`）が変わった
 * とき——ビューを開いた・レビューが増えた・リポジトリを選んだとき——にだけ引き直す。
 * 「前回から今まで」の件数はその間にも増えていくが、サーバー側のキャッシュが10分で捨てるので、
 * 開き直せば追いつく。
 *
 * 取れなかった期間は戻り値に入らない（画面は「—」を出す）。
 */
export function useCodeReviewMergedPrCounts(rangeKeys: readonly string[]): {
  counts: ReadonlyMap<string, number>;
  loading: boolean;
} {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  // 並びが変わっただけで引き直さない
  const requestKey = [...new Set(rangeKeys)].sort().join("\n");

  useEffect(() => {
    if (requestKey === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);

    async function load() {
      try {
        const params = new URLSearchParams();
        for (const key of requestKey.split("\n")) params.append("range", key);
        const res = await fetch(`/api/code-review/merged-pr-counts?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: { counts?: { key: string; count: number }[] } = await res.json();
        if (cancelled) return;
        // 前に取れた件数は残す（選択を切り替えるたびに数字が消えて出直すのを避ける）
        setCounts((previous) => {
          const next = new Map(previous);
          for (const entry of data.counts ?? []) next.set(entry.key, entry.count);
          return next;
        });
      } catch {
        // 取れなければ件数を出さないだけ
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [requestKey]);

  return { counts, loading };
}
