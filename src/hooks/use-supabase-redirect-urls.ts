"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Supabase Redirect URLsの取得・操作（#3568）。`use-shared-tokens.ts`と同じ形。
 *
 * **`enabled`は`LazyFleetPanel`が初めて開かれた時点で真になる。** それより前には取得しない
 * （フリート運用を開いただけでSupabaseへ問い合わせない）。
 */
export function useSupabaseRedirectUrls(enabled: boolean) {
  const [data, setData] = useState<string[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    setNotConfigured(false);

    fetch("/api/settings/supabase-redirect-urls")
      .then((res) => {
        if (res.status === 501) {
          if (!cancelled) setNotConfigured(true);
          return null;
        }
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ redirectUrls: string[] }>;
      })
      .then((json) => {
        if (!cancelled && json) setData(json.redirectUrls);
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

  return { data, isLoading, error, notConfigured, refetch };
}

function messageForStatus(status: number, fallback: string): string {
  if (status === 409) return "すでに登録されています";
  if (status === 404) return "対象のURLが見つかりません。一覧を更新してください";
  if (status === 400) return "入力内容が不正です。http(s)://から始まるURLを入力してください";
  return `${fallback} (${status})`;
}

export function useSupabaseRedirectUrlMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addRedirectUrl(url: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/supabase-redirect-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(messageForStatus(res.status, "登録に失敗しました"));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function replaceRedirectUrl(oldUrl: string, newUrl: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/supabase-redirect-urls", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldUrl, newUrl }),
      });
      if (!res.ok) throw new Error(messageForStatus(res.status, "更新に失敗しました"));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function removeRedirectUrl(url: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/supabase-redirect-urls", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(messageForStatus(res.status, "削除に失敗しました"));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { addRedirectUrl, replaceRedirectUrl, removeRedirectUrl, isSubmitting, error, setError };
}
