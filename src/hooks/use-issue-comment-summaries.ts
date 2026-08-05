"use client";

import { useCallback, useEffect, useState } from "react";

import type { Issue } from "@/types/issue";

export type CommentSummaryState = {
  summary: string;
  generatedAt: string;
};

type CommentSummaryListItem = {
  commentId: string;
  summary: string;
  generatedAt: string;
};

export function useIssueCommentSummaries(issue: Issue | null) {
  const [summaries, setSummaries] = useState<Record<string, CommentSummaryState>>({});
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notConfigured, setNotConfigured] = useState(false);

  const issueId = issue?.id ?? null;
  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueNumber = issue?.number ?? null;

  useEffect(() => {
    // 選択中のIssueが切り替わるたびに、DBキャッシュ済みのコメント要約（あれば）を取得し直す
    // 一度きりの同期処理。Anthropicへは問い合わせない（明示的な「要約を生成」操作はgenerate()で行う）。
    if (!issueId || !repositoryFullName || issueNumber === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummaries({});
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    fetch(`/api/issues/comments/summary?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data: { summaries: CommentSummaryListItem[] } = await res.json();
        const next: Record<string, CommentSummaryState> = {};
        for (const item of data.summaries) {
          next[item.commentId] = { summary: item.summary, generatedAt: item.generatedAt };
        }
        setSummaries(next);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [issueId, repositoryFullName, issueNumber]);

  const generate = useCallback(
    async (commentId: string) => {
      if (!repositoryFullName || issueNumber === null) return;
      const [owner, repo] = repositoryFullName.split("/");

      setGeneratingIds((prev) => new Set(prev).add(commentId));
      setErrors((prev) => {
        if (!(commentId in prev)) return prev;
        const next = { ...prev };
        delete next[commentId];
        return next;
      });
      setNotConfigured(false);

      try {
        const res = await fetch("/api/issues/comments/summary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner, repo, number: issueNumber, commentId: Number(commentId) }),
        });
        if (res.status === 501) {
          setNotConfigured(true);
          return;
        }
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `要約の生成に失敗しました (${res.status})`);
        }
        const data: CommentSummaryListItem = await res.json();
        setSummaries((prev) => ({
          ...prev,
          [data.commentId]: { summary: data.summary, generatedAt: data.generatedAt },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrors((prev) => ({ ...prev, [commentId]: message }));
      } finally {
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(commentId);
          return next;
        });
      }
    },
    [repositoryFullName, issueNumber],
  );

  return { summaries, generatingIds, errors, notConfigured, generate };
}

export type IssueCommentSummaries = ReturnType<typeof useIssueCommentSummaries>;
