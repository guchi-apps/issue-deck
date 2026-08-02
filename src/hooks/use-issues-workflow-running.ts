"use client";

import { useEffect, useRef, useState } from "react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 20_000;

type RunningState = { isRunning: boolean; currentStep: string | null };
type RunningMap = Record<string, RunningState>;
type ApiRunningState = RunningState & { runId: number | null };

const NOT_RUNNING: ApiRunningState = { isRunning: false, currentStep: null, runId: null };

/**
 * 一覧に表示中のIssueのうち、実装状況ラベル（01.wip〜09.main）が付き承認待ち
 * （00.check-user）でないものについて、対応するGitHub Actions実行が進行中かどうかをポーリングする
 */
export function useIssuesWorkflowRunning(issues: Issue[]): RunningMap {
  const [running, setRunning] = useState<RunningMap>({});
  const knownRunIdsRef = useRef<Map<string, number>>(new Map());
  const candidates = issues.filter(
    (issue) => getWorkflowStepIndex(issue.labels) !== null && !isApprovalPending(issue.labels),
  );
  const candidateKey = candidates
    .map((issue) => issue.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (candidates.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRunning({});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const knownRunIds = knownRunIdsRef.current;

    async function poll() {
      if (document.hidden) return;
      const results = await Promise.all(
        candidates.map(async (issue) => {
          const [owner, repo] = issue.repositoryFullName.split("/");
          try {
            const params = new URLSearchParams({ owner, repo, number: String(issue.number) });
            const knownRunId = knownRunIds.get(issue.id);
            if (knownRunId !== undefined) {
              params.set("knownRunId", String(knownRunId));
            }
            const res = await fetch(`/api/issues/workflow-running?${params.toString()}`, {
              signal: controller.signal,
            });
            if (!res.ok) return [issue.id, NOT_RUNNING] as const;
            const data: ApiRunningState = await res.json();
            return [issue.id, data] as const;
          } catch {
            return [issue.id, NOT_RUNNING] as const;
          }
        }),
      );
      if (cancelled) return;
      for (const [issueId, data] of results) {
        if (data.runId !== null) {
          knownRunIds.set(issueId, data.runId);
        } else {
          knownRunIds.delete(issueId);
        }
      }
      setRunning(
        Object.fromEntries(
          results.map(([issueId, data]) => [
            issueId,
            { isRunning: data.isRunning, currentStep: data.currentStep },
          ]),
        ),
      );
    }

    poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  return running;
}
