"use client";

import { useCallback, useState } from "react";

import type { IssueBodyCleanupResult } from "@/lib/claude/issue-body-cleanup";

export function useIssueBodyCleanup() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const generate = useCallback(async (body: string): Promise<IssueBodyCleanupResult | null> => {
    setIsGenerating(true);
    setError(null);
    setNotConfigured(false);

    try {
      const res = await fetch("/api/issues/body-cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.status === 501) {
        setNotConfigured(true);
        return null;
      }
      if (!res.ok) {
        const data: { message?: string } = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `本文の整形に失敗しました (${res.status})`);
      }
      return (await res.json()) as IssueBodyCleanupResult;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  return { isGenerating, error, notConfigured, generate };
}
