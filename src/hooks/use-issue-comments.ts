"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

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
  const qaAnswerPendingAt = issue?.qaAnswerPendingAt ?? null;

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
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `コメントの取得に失敗しました (${res.status})`);
        }
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

  /**
   * Claudeの回答が届いた瞬間だけ、コメントを取り直す（#2309）。
   *
   * この画面はコメントを定期的に取り直していないため、開いたまま待っていると回答が届いても
   * 何も変わらず、コメント欄の「回答待ち」（`CommentThread`の待ちの吹き出し）が残り続ける。
   *
   * **合図に使うのは`qaAnswerPendingAt`が立ち→消えへ変わったこと。** この列は回答コメントの
   * 到着をGitHubのWebhookで受けて更新され（`updateQaAnswerPendingState`）、Issue一覧の
   * ポーリング（10秒ごと・DBのみでGitHub APIを消費しない）に乗ってここまで届く。
   * **待っているあいだ定期的に取りに行く作りにはしない**——待ち時間が数分に及ぶことがあり、
   * この取得はGitHub APIを消費するため。走るのは回答1件につき1回。
   *
   * `isLoading`は立てない。立てると、届いた瞬間に読んでいたコメントが読み込み中の骨組みへ
   * 差し替わる。
   */
  const prevQaRef = useRef<{ issueId: string | null; pendingAt: string | null }>({
    issueId,
    pendingAt: qaAnswerPendingAt,
  });
  useEffect(() => {
    const prev = prevQaRef.current;
    prevQaRef.current = { issueId, pendingAt: qaAnswerPendingAt };
    // Issueを選び直した直後は上の取得effectが取り直しているので、ここでは何もしない
    if (prev.issueId !== issueId) return;
    if (prev.pendingAt === null || qaAnswerPendingAt !== null) return;
    if (!issueId || !repositoryFullName || issueNumber === null) return;

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();

    fetch(`/api/issues/comments?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data: { comments: IssueComment[] } = await res.json();
        setComments(data.comments);
      })
      // 取り直しは補助的な更新なので、失敗しても画面へエラーを出さない（元の内容が残る）
      .catch(() => {});

    return () => controller.abort();
  }, [qaAnswerPendingAt, issueId, repositoryFullName, issueNumber]);

  return { comments, isLoading, error, setComments };
}
