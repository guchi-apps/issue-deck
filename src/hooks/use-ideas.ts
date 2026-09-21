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

export function useIdeas(active = true) {
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "構想を取得できませんでした");
    } finally {
      setIsLoading(false);
    }
  }, []);

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
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "構想を削除できませんでした");
      return false;
    } finally {
      setDeletingPath(null);
    }
  }, []);

  return { ideas, isLoading, deletingPath, error, refresh, remove };
}
