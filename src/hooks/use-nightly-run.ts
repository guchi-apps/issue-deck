"use client";

import { useCallback, useEffect, useState } from "react";

import type { NightlyRunSettings, NightlyRunState } from "@/lib/nightly-run";

/** 画面を開いているあいだの取り直しの間隔。夜の起動は30秒ごとの巡回で進むので、それに揃える */
const ACTIVE_REFRESH_INTERVAL_MS = 30_000;
/** 画面を開いていないあいだの取り直しの間隔（左メニューの件数のため） */
const IDLE_REFRESH_INTERVAL_MS = 5 * 60_000;

async function readErrorMessage(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  return json.message ?? `リクエストに失敗しました (${res.status})`;
}

/**
 * 「夜間実行」画面（#2772）のデータ取得と操作。
 *
 * **1画面で1回だけ呼び、左メニューの件数とパネルの両方へ配る**（`useDispatchState`と同じ形）。
 * 開いていないあいだも件数のためにゆっくり取り直し、開いているあいだは巡回の間隔に合わせて
 * 取り直す（夜の起動・朝の結果が動くのはサブPCの巡回のたび）。
 */
export function useNightlyRun(active: boolean) {
  const [state, setState] = useState<NightlyRunState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      setIsLoading(true);
      try {
        const res = await fetch("/api/nightly-run", { cache: "no-store" });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const json = (await res.json()) as NightlyRunState;
        if (!cancelled) {
          setState(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          timerId = setTimeout(
            load,
            active ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS,
          );
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [active, reloadKey]);

  const cancel = useCallback(
    async (entryId: string): Promise<boolean> => {
      setIsSubmitting(true);
      setError(null);
      try {
        const res = await fetch(`/api/nightly-run/${encodeURIComponent(entryId)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        // 取り消した行は取り直しを待たずに落とす
        setState((prev) =>
          prev ? { ...prev, queued: prev.queued.filter((entry) => entry.id !== entryId) } : prev,
        );
        refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [refresh],
  );

  const updateSettings = useCallback(
    async (patch: Partial<NightlyRunSettings>): Promise<boolean> => {
      setIsSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/nightly-run/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const settings = (await res.json()) as NightlyRunSettings;
        setState((prev) => (prev ? { ...prev, settings } : prev));
        // 開始時刻が変わると窓も変わるので取り直す
        refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [refresh],
  );

  return { state, isLoading, error, isSubmitting, refresh, cancel, updateSettings };
}

export type NightlyRunHandle = ReturnType<typeof useNightlyRun>;

/**
 * 「実装を開始」ダイアログが「今夜の夜間実行」の説明を出すための設定だけの取得（#2772）。
 * ダイアログを開いている間だけ取り、閉じれば捨てる。
 */
export function useNightlyRunSettings(enabled: boolean): NightlyRunSettings | null {
  const [settings, setSettings] = useState<NightlyRunSettings | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/nightly-run/settings", { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as NightlyRunSettings) : null))
      .then((json) => {
        if (!cancelled && json) setSettings(json);
      })
      .catch(() => {
        // 取れなくても積むことはできる（説明の時刻が出ないだけ）
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return settings;
}
