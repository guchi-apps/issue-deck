"use client";

import { useCallback, useEffect, useState } from "react";

import type { Issue } from "@/types/issue";

export type IssueSummaryState = {
  summary: string | null;
  generatedAt: string | null;
  commentCountAtGeneration: number | null;
  currentCommentCount: number;
};

export function useIssueSummary(issue: Issue | null) {
  const [state, setState] = useState<IssueSummaryState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const issueId = issue?.id ?? null;
  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueNumber = issue?.number ?? null;

  useEffect(() => {
    // 選択中のIssueが切り替わるたびに、DBキャッシュ済みの要約（あれば）を取得し直す一度きりの
    // 同期処理。Anthropicへは問い合わせない（明示的な「要約を生成」操作はgenerate()で行う）。
    if (!issueId || !repositoryFullName || issueNumber === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(null);
      setError(null);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);
    setError(null);

    fetch(`/api/issues/summary?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `要約の取得に失敗しました (${res.status})`);
        }
        const data: IssueSummaryState = await res.json();
        setState(data);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [issueId, repositoryFullName, issueNumber]);

  const generate = useCallback(async () => {
    if (!repositoryFullName || issueNumber === null) return;
    const [owner, repo] = repositoryFullName.split("/");

    setIsGenerating(true);
    setError(null);
    setNotConfigured(false);

    try {
      const res = await fetch("/api/issues/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, repo, number: issueNumber }),
      });
      if (res.status === 501) {
        setNotConfigured(true);
        return;
      }
      if (!res.ok) {
        const data: { message?: string } = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `要約の生成に失敗しました (${res.status})`);
      }
      const data: IssueSummaryState = await res.json();
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  }, [repositoryFullName, issueNumber]);

  return { state, isLoading, isGenerating, error, notConfigured, generate };
}
