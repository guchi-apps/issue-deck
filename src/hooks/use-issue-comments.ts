"use client";

import { useEffect, useState } from "react";

import type { Issue, IssueComment } from "@/types/issue";

type UseIssueCommentsResult = {
  comments: IssueComment[];
  isLoading: boolean;
  error: string | null;
};

export function useIssueComments(issue: Issue | null): UseIssueCommentsResult {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 選択中のIssue（外部から渡されるprop）が切り替わるたびに、対応するコメントを
    // 外部システム（GitHub API）から取得し直す。イベントハンドラ内ではなくエフェクトで
    // 行う必要がある一度きりの同期処理であり、ループや連鎖的な再レンダリングは発生しない。
    if (!issue) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setComments([]);
      setError(null);
      return;
    }

    const [owner, repo] = issue.repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);
    setError(null);

    fetch(`/api/issues/comments?owner=${owner}&repo=${repo}&number=${issue.number}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`コメントの取得に失敗しました (${res.status})`);
        const data: { comments: IssueComment[] } = await res.json();
        setComments(data.comments);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setIsLoading(false));

    return () => controller.abort();
  }, [issue]);

  return { comments, isLoading, error };
}
