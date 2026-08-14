"use client";

import { useEffect, useRef, useState } from "react";

import { isApprovalPending } from "@/lib/github/approval-labels";
import { hasActiveWorkflowStep } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";

const POLL_INTERVAL_MS = 20_000;

/**
 * `runId`もそのまま画面へ渡す。実行が一度も紐づいていない（null）ことが、
 * 「Statusは進んでいるのに起動していない」＝起動待ちの判定材料になるため（#991 Phase 3）。
 */
type RunningState = { isRunning: boolean; currentStep: string | null; runId: number | null };
type RunningMap = Record<string, RunningState>;

const NOT_RUNNING: RunningState = { isRunning: false, currentStep: null, runId: null };

/**
 * 一覧に表示中のIssueのうち、実行が進行し得るProject Status（Planning / Implementation /
 * Develop PR / Release）にあり承認待ち（00.check-user）でないものについて、対応する
 * GitHub Actions実行が進行中かどうかをポーリングする。
 * `Develop`・`Done`はマージ完了後の定常状態で実行は走らないため、GitHub APIの消費を抑える
 * 目的で対象から除外している（判定は`hasActiveWorkflowStep`＝`PROGRESS_STATUSES`の`active`）。
 */
export function useIssuesWorkflowRunning(
  issues: Issue[],
  /**
   * ポーリングから外すIssueのid（#1262）。**サブPCで走っているIssueを渡す。**
   * そちらはGitHub Actionsの実行が最初から存在しないため、問い合わせても常に「無し」が返る。
   * 一覧に並ぶ件数だけ20秒ごとに叩くので、外さないとGitHub APIを空振りで消費し続ける。
   */
  excludedIssueIds?: ReadonlySet<string>,
): RunningMap {
  const [running, setRunning] = useState<RunningMap>({});
  const knownRunIdsRef = useRef<Map<string, number>>(new Map());
  const candidates = issues.filter(
    (issue) =>
      hasActiveWorkflowStep(issue) &&
      !isApprovalPending(issue.labels) &&
      !excludedIssueIds?.has(issue.id),
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
            const data: RunningState = await res.json();
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
