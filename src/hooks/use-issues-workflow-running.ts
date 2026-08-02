"use client";

import { useEffect, useState } from "react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { getWorkflowStepIndex } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 5_000;

type RunningMap = Record<string, boolean>;

/**
 * 一覧に表示中のIssueのうち、実装状況ラベル（01.wip〜09.main）が付き承認待ち
 * （00.check-user）でないものについて、対応するGitHub Actions実行が進行中かどうかをポーリングする
 */
export function useIssuesWorkflowRunning(issues: Issue[]): RunningMap {
  const [running, setRunning] = useState<RunningMap>({});
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

    async function poll() {
      if (document.hidden) return;
      const results = await Promise.all(
        candidates.map(async (issue) => {
          const [owner, repo] = issue.repositoryFullName.split("/");
          try {
            const res = await fetch(
              `/api/issues/workflow-running?owner=${owner}&repo=${repo}&number=${issue.number}`,
              { signal: controller.signal },
            );
            if (!res.ok) return [issue.id, false] as const;
            const data: { isRunning: boolean } = await res.json();
            return [issue.id, data.isRunning] as const;
          } catch {
            return [issue.id, false] as const;
          }
        }),
      );
      if (cancelled) return;
      setRunning(Object.fromEntries(results));
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
