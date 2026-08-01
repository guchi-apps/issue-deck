"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { Issue, IssueComment } from "@/types/issue";

type UseIssueCommentsResult = {
  comments: IssueComment[];
  isLoading: boolean;
  error: string | null;
  setComments: Dispatch<SetStateAction<IssueComment[]>>;
};

export function useIssueComments(issue: Issue | null): UseIssueCommentsResult {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issueId = issue?.id ?? null;
  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueNumber = issue?.number ?? null;

  useEffect(() => {
    // 選択中のIssue（外部から渡されるprop）が切り替わるたびに、対応するコメントを
    // 外部システム（GitHub API）から取得し直す。issueオブジェクト自体ではなくid等の
    // 識別子に依存させることで、ポーリングによる同一Issueの再取得（オブジェクト参照の
    // 更新）ではエフェクトが再実行されず、表示中のコメントが定期的に読み込み中表示へ
    // 差し替わるのを防ぐ。イベントハンドラ内ではなくエフェクトで行う必要がある
    // 一度きりの同期処理であり、ループや連鎖的な再レンダリングは発生しない。
    if (!issueId || !repositoryFullName || issueNumber === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setComments([]);
      setError(null);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    setIsLoading(true);
    setError(null);

    fetch(`/api/issues/comments?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
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
  }, [issueId, repositoryFullName, issueNumber]);

  return { comments, isLoading, error, setComments };
}
