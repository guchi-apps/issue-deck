"use client";

import { fetchWithRetry } from "@/lib/client-error-message";
import { useEffect, useState } from "react";

import type { IssueLabel } from "@/types/issue";

type UseIssueRepoMetaResult = {
  labels: IssueLabel[];
  assignees: string[];
  isLoading: boolean;
  /** 取得が一度完了した（成功・失敗を問わない）。リポジトリが変わると`false`へ戻る（#5448） */
  isLoaded: boolean;
};

export function useIssueRepoMeta(repositoryFullName: string | null): UseIssueRepoMetaResult {
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!repositoryFullName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLabels([]);
      setAssignees([]);
      // 閉じている間に戻しておく。再オープン時に前回の完了を持ち越さない（#5448）
      setIsLoaded(false);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);
    setIsLoaded(false);

    fetchWithRetry(`/api/issues/meta?owner=${owner}&repo=${repo}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`リポジトリ情報の取得に失敗しました (${res.status})`);
        const data: { labels: IssueLabel[]; assignees: string[] } = await res.json();
        setLabels(data.labels);
        setAssignees(data.assignees);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLabels([]);
        setAssignees([]);
      })
      .finally(() => {
        // 中断（リポジトリの切り替え・閉じた）では完了扱いにしない
        if (controller.signal.aborted) return;
        setIsLoading(false);
        setIsLoaded(true);
      });

    return () => controller.abort();
  }, [repositoryFullName]);

  return { labels, assignees, isLoading, isLoaded };
}
