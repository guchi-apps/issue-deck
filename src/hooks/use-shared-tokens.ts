"use client";

import { useCallback, useEffect, useState } from "react";

import type { SharedToken, SharedTokenInput } from "@/types/shared-token";

export function useSharedTokens(enabled: boolean) {
  const [data, setData] = useState<SharedToken[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // 設定画面を開いたタイミング・再取得要求のタイミングで取得する同期処理。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    fetch("/api/settings/shared-tokens")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ sharedTokens: SharedToken[] }>;
      })
      .then((json) => {
        if (!cancelled) setData(json.sharedTokens);
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
  }, [enabled, reloadKey]);

  const refetch = useCallback(() => setReloadKey((key) => key + 1), []);
  return { data, isLoading, error, refetch };
}

export function useSharedTokenMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSharedToken(input: SharedTokenInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/shared-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error("同じ名前のトークンが既に登録されています");
        if (res.status === 400) throw new Error("入力内容が不正です。トークン名・値の入力と各項目の文字数を確認してください");
        throw new Error(`登録に失敗しました (${res.status})`);
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function revealSharedToken(id: string): Promise<string | null> {
    setError(null);
    try {
      const res = await fetch(`/api/settings/shared-tokens/${id}`);
      if (!res.ok) throw new Error(`表示に失敗しました (${res.status})`);
      const json = (await res.json()) as { value: string };
      return json.value;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function deleteSharedToken(id: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/shared-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`削除に失敗しました (${res.status})`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { createSharedToken, revealSharedToken, deleteSharedToken, isSubmitting, error };
}
