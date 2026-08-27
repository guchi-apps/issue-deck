"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { buildSnoozeKey, buildSnoozeMap, type SnoozeEntry, type SnoozeMap, type SnoozeTarget } from "@/lib/snooze";

const EMPTY: SnoozeEntry[] = [];

export type UseSnoozesResult = {
  /** 引き当て表。効いているかどうかの判定は`src/lib/snooze.ts`の関数へ渡す */
  snoozes: SnoozeMap;
  /** 期限切れも含む全件。「保留中N件」の内訳を出すときに使う */
  entries: SnoozeEntry[];
  /** 保留にする・期限を付け替える。`until`がnullなら手動で解除するまで */
  snooze: (target: SnoozeTarget, until: string | null) => Promise<void>;
  /** 保留を解除する */
  unsnooze: (target: SnoozeTarget) => Promise<void>;
};

/**
 * ユーザーごとの保留（#2398）を取得し、付け外しする。
 *
 * **画面全体で1回だけ取る。** 保留は左メニューの件数・一覧・ベル・トーストが同時に読むもので、
 * 場所ごとに取りに行くと同じ瞬間に違う集合を見る。取得はダッシュボードのマウント時の1回だけで、
 * 以降は付け外しの結果を手元の配列へ反映する（ポーリングしない——変えるのはこの画面だけ）。
 *
 * **失敗しても保留は空のまま扱う。** 伏せられないだけで、要対応の項目は今までどおり並ぶ。
 * 逆に「取れなかったから伏せたままにする」と、消えた理由が画面から読めなくなる。
 */
export function useSnoozes(): UseSnoozesResult {
  const [entries, setEntries] = useState<SnoozeEntry[]>(EMPTY);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/snoozes", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`snoozes fetch failed (${res.status})`);
        return (await res.json()) as { snoozes?: SnoozeEntry[] };
      })
      .then((data) => setEntries(data.snoozes ?? EMPTY))
      .catch(() => {
        if (!controller.signal.aborted) setEntries(EMPTY);
      });
    return () => controller.abort();
  }, []);

  const snooze = useCallback(async (target: SnoozeTarget, until: string | null) => {
    // 押した瞬間に一覧から消えるよう、先に手元を書き換える（保留は取り消しの効く操作で、
    // 失敗しても次の取得で戻る）
    setEntries((prev) => [
      ...prev.filter((entry) => buildSnoozeKey(entry) !== buildSnoozeKey(target)),
      { ...target, until },
    ]);
    const res = await fetch("/api/snoozes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, until }),
    }).catch(() => null);
    if (!res?.ok) {
      setEntries((prev) =>
        prev.filter((entry) => buildSnoozeKey(entry) !== buildSnoozeKey(target)),
      );
    }
  }, []);

  const unsnooze = useCallback(async (target: SnoozeTarget) => {
    const key = buildSnoozeKey(target);
    let removed: SnoozeEntry | null = null;
    setEntries((prev) => {
      removed = prev.find((entry) => buildSnoozeKey(entry) === key) ?? null;
      return prev.filter((entry) => buildSnoozeKey(entry) !== key);
    });
    const res = await fetch("/api/snoozes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    }).catch(() => null);
    if (!res?.ok && removed) {
      const restored: SnoozeEntry = removed;
      setEntries((prev) => [...prev, restored]);
    }
  }, []);

  const snoozes = useMemo(() => buildSnoozeMap(entries), [entries]);

  return { snoozes, entries, snooze, unsnooze };
}
