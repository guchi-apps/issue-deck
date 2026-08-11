"use client";

import { useCallback, useEffect, useState } from "react";

import type { OpenPullRequest, PullRequestDetail } from "@/types/pull-request";

type UsePullRequestDetailResult = {
  detail: PullRequestDetail | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * 選択中PRの本文・コメントを取得する（#1087）。
 *
 * 一覧（`use-open-pull-requests.ts`）と同じく**自動ポーリングしない**。1件の取得で
 * GitHub APIを4回消費するうえ、PRの本文やコメントは開いている間に何度も変わるものではない。
 * 新しいコメントを取り込みたいときは詳細ヘッダーの更新ボタン（`refresh`）を使う。
 */
export function usePullRequestDetail(
  pullRequest: OpenPullRequest | null,
): UsePullRequestDetailResult {
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  const repositoryFullName = pullRequest?.repositoryFullName ?? null;
  const number = pullRequest?.number ?? null;

  useEffect(() => {
    if (!repositoryFullName || number === null) return;

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      // 別のPRへ切り替えた直後に前のPRの本文が残って見えないよう、取得前に必ず伏せる。
      setDetail(null);
      setError(null);
      setIsLoading(true);
      try {
        const [owner, repo] = (repositoryFullName ?? "").split("/");
        const params = new URLSearchParams({
          owner,
          repo,
          number: String(number),
        });
        const res = await fetch(`/api/pull-requests/detail?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `リクエストに失敗しました (${res.status})`,
          );
        }
        const data: PullRequestDetail = await res.json();
        if (cancelled) return;
        setDetail(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [repositoryFullName, number, reloadKey]);

  return { detail, isLoading, error, refresh };
}
