"use client";

import { useEffect, useState } from "react";

import type { IssueLabel } from "@/types/issue";

type UseIssueRepoMetaResult = {
  labels: IssueLabel[];
  assignees: string[];
  isLoading: boolean;
};

export function useIssueRepoMeta(repositoryFullName: string | null): UseIssueRepoMetaResult {
  const [labels, setLabels] = useState<IssueLabel[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!repositoryFullName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLabels([]);
      setAssignees([]);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);

    fetch(`/api/issues/meta?owner=${owner}&repo=${repo}`, { signal: controller.signal })
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
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [repositoryFullName]);

  return { labels, assignees, isLoading };
}
