"use client";

import { useEffect, useState } from "react";

import { findLatestWorkflowRunLogComment } from "@/lib/github/workflow-run-log";
import type { Issue, IssueComment } from "@/types/issue";

const POLL_INTERVAL_MS = 20_000;

export type WorkflowRunInfo = {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  startedAt: string;
  updatedAt: string;
};

type UseIssueWorkflowRunResult = {
  run: WorkflowRunInfo | null;
  isLoading: boolean;
  runId: number | null;
  /** 実行時間表示を該当コメントの横に配置するための、実行ログリンクを含むコメントのID */
  commentId: string | null;
};

/** Issueのコメントから直近の「実行ログ:」リンクを見つけ、その実行の状態をポーリングする */
export function useIssueWorkflowRun(
  issue: Issue | null,
  comments: IssueComment[],
): UseIssueWorkflowRunResult {
  const [run, setRun] = useState<WorkflowRunInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueId = issue?.id ?? null;
  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];
  const runMatch = owner && repo ? findLatestWorkflowRunLogComment(comments, owner, repo) : null;
  const runId = runMatch?.runId ?? null;

  useEffect(() => {
    if (!owner || !repo || !runId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRun(null);
      return;
    }

    let cancelled = false;
    let isCompleted = false;
    const controller = new AbortController();

    async function fetchRun() {
      if (document.hidden || isCompleted) return;
      try {
        const res = await fetch(
          `/api/issues/workflow-run?owner=${owner}&repo=${repo}&runId=${runId}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data: { run: WorkflowRunInfo } = await res.json();
        if (cancelled) return;
        setRun(data.run);
        isCompleted = data.run.status === "completed";
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    setIsLoading(true);
    fetchRun();
    const intervalId = setInterval(fetchRun, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, [owner, repo, runId, issueId]);

  return { run, isLoading, runId, commentId: runMatch?.commentId ?? null };
}
