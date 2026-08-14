"use client";

import { useEffect, useState } from "react";

import type { Issue, SubIssueRelations } from "@/types/issue";

const EMPTY: SubIssueRelations = { parent: null, children: [], childCount: 0 };

type UseIssueSubIssuesResult = {
  relations: SubIssueRelations;
  isLoading: boolean;
};

/**
 * 選択中のIssueの親子関係を取得する。`use-issue-comments.ts`と同じ形で、
 * **id等の識別子に依存させることでポーリングによる再取得では走らせない**
 * （表示中のセクションが定期的に読み込み中へ差し替わるのを防ぐ）。
 *
 * 取得に失敗した場合はAPI側が「関係なし」を返すため、ここにエラー状態は持たない
 * （src/app/api/issues/sub-issues/route.ts の判断）。
 */
export function useIssueSubIssues(issue: Issue | null): UseIssueSubIssuesResult {
  const [relations, setRelations] = useState<SubIssueRelations>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const issueId = issue?.id ?? null;
  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueNumber = issue?.number ?? null;

  useEffect(() => {
    if (!issueId || !repositoryFullName || issueNumber === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRelations(EMPTY);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);

    fetch(`/api/issues/sub-issues?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`sub-issues fetch failed (${res.status})`);
        const data: { relations: SubIssueRelations } = await res.json();
        setRelations(data.relations ?? EMPTY);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setRelations(EMPTY);
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [issueId, repositoryFullName, issueNumber]);

  return { relations, isLoading };
}
