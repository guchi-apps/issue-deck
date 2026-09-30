"use client";

import { useCallback, useEffect, useState } from "react";

export type IdeaSummary = {
  name: string;
  path: string;
  title: string;
  state: string | null;
  summary: string | null;
  markdown: string;
};

/**
 * 左メニュー「構想」の件数（#3639）。数えるのは`ideas/`直下のディレクトリ数で、
 * 本文は読まない（1リクエスト）。読み込めない間・リポジトリを読めない環境は`null`で、
 * 0件と区別する。構想画面で取得・削除したあとは`refresh`で取り直す。
 */
export function useIdeasCount() {
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/new-app/ideas");
      const json = (await response.json().catch(() => null)) as
        | { available?: boolean; ideas?: unknown[] }
        | null;
      setCount(response.ok && json?.available && Array.isArray(json.ideas) ? json.ideas.length : null);
    } catch {
      setCount(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  return { count, refresh };
}

export function useIdeas(active = true, onChanged?: () => void) {
  const [ideas, setIdeas] = useState<IdeaSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/new-app/ideas?details=1");
      const json = (await response.json().catch(() => null)) as
        | { available?: boolean; ideas?: IdeaSummary[]; message?: string }
        | null;
      if (!response.ok) throw new Error(json?.message ?? `構想を取得できませんでした (${response.status})`);
      if (!json?.available) throw new Error("guchi-apps/ideas を読み込めませんでした");
      setIdeas(json.ideas ?? []);
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "構想を取得できませんでした");
    } finally {
      setIsLoading(false);
    }
  }, [onChanged]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [active, refresh]);

  const remove = useCallback(async (path: string) => {
    setDeletingPath(path);
    setError(null);
    try {
      const response = await fetch("/api/new-app/ideas", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const json = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(json?.message ?? `構想を削除できませんでした (${response.status})`);
      setIdeas((current) => current.filter((idea) => idea.path !== path));
      onChanged?.();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "構想を削除できませんでした");
      return false;
    } finally {
      setDeletingPath(null);
    }
  }, [onChanged]);

  return { ideas, isLoading, deletingPath, error, refresh, remove };
}
