"use client";

import { useCallback, useEffect, useState } from "react";

import type { PushKind } from "@/lib/notifications/push-kinds";

/**
 * Push通知の種類ごとのON/OFF（#4159）を読み書きするフック。ユーザー単位で、端末をまたいで効く。
 * 切り替えは先に画面へ反映し、保存に失敗したら元へ戻してエラーを出す。
 */
export function usePushKindPreferences(enabled: boolean) {
  const [value, setValue] = useState<Record<PushKind, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications/preferences");
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const json = (await res.json()) as { enabled: Record<PushKind, boolean> };
        if (!cancelled) setValue(json.enabled);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const setKindEnabled = useCallback(async (kind: PushKind, next: boolean) => {
    setError(null);
    setValue((current) => (current ? { ...current, [kind]: next } : current));
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, enabled: next }),
      });
      if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
      const json = (await res.json()) as { enabled: Record<PushKind, boolean> };
      setValue(json.enabled);
    } catch (err) {
      setValue((current) => (current ? { ...current, [kind]: !next } : current));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { value, error, setKindEnabled };
}
