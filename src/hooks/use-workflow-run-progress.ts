"use client";

import { useEffect, useState } from "react";

import type { WorkflowRunProgress } from "@/lib/workflow-run-progress";

/**
 * 実行の内訳（`GET /api/workflow-runs`）を、**パネルを開いている間だけ**取得する（#2777）。
 *
 * 閉じている間は1回も呼ばない。開いたら1回取り、実行が終わるまでは短い間隔で取り直す
 * （終わったら止める）。ブランチ画面のデプロイ状況（30秒）より短いのは、内訳を開いている人は
 * 「いまどのジョブか」を見にきているため。タブが裏にある間は取りに行かない。
 */
const POLL_INTERVAL_MS = 15_000;

export type UseWorkflowRunProgressResult = {
  progress: WorkflowRunProgress | null;
  isLoading: boolean;
  /** 取得に失敗したときの文言。成功・未取得はnull */
  error: string | null;
};

export function useWorkflowRunProgress(
  repositoryFullName: string | null,
  runId: number | null,
  enabled: boolean,
): UseWorkflowRunProgressResult {
  const [progress, setProgress] = useState<WorkflowRunProgress | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !repositoryFullName || !runId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 閉じたら前回の内訳を残さない
      setProgress(null);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    if (!owner || !repo) return;

    let cancelled = false;
    let isCompleted = false;
    const controller = new AbortController();

    async function fetchProgress() {
      if (document.hidden || isCompleted) return;
      try {
        const res = await fetch(
          `/api/workflow-runs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&runId=${runId}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          if (!cancelled) setError("実行の内訳を取得できませんでした");
          return;
        }
        const data: { progress: WorkflowRunProgress } = await res.json();
        if (cancelled) return;
        setProgress(data.progress);
        setError(null);
        isCompleted = data.progress.status === "completed";
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!cancelled) setError("実行の内訳を取得できませんでした");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    setIsLoading(true);
    setError(null);
    fetchProgress();
    const intervalId = setInterval(fetchProgress, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, [enabled, repositoryFullName, runId]);

  return { progress, isLoading, error };
}
