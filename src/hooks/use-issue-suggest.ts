"use client";

import { useCallback, useState } from "react";

import type { IssueSuggestLabelInput, IssueSuggestResult } from "@/lib/claude/issue-suggest";

export function useIssueSuggest() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const generate = useCallback(
    async (body: string, labels: IssueSuggestLabelInput[]): Promise<IssueSuggestResult | null> => {
      setIsGenerating(true);
      setError(null);
      setNotConfigured(false);

      try {
        const res = await fetch("/api/issues/suggest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, labels }),
        });
        if (res.status === 501) {
          setNotConfigured(true);
          return null;
        }
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `提案の生成に失敗しました (${res.status})`);
        }
        return (await res.json()) as IssueSuggestResult;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsGenerating(false);
      }
    },
    [],
  );

  return { isGenerating, error, notConfigured, generate };
}
