"use client";

import { useCallback, useEffect, useState } from "react";

import type { PullRequestSummary, OpenPullRequestsResponse } from "@/types/pull-request";

type UseOpenPullRequestsResult = {
  pullRequests: PullRequestSummary[];
  /** 取得に失敗したリポジトリのfullName（部分的な欠落を画面に出すため） */
  failedRepositories: string[];
  /** 最終取得時刻（ISO8601）。未取得はnull */
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * マージ待ち（open）のPull Requestをリポジトリ横断で取得する。
 *
 * **自動ポーリングは行わない。** 1回の取得で「リポジトリ数 + draft以外のPR数」ぶんのGitHub API
 * を消費するため（[/api/pull-requests](../app/api/pull-requests/route.ts)）、他のポーリング系
 * フック（use-pull-request-ci-status等が対象1件を追うのとは規模が違う）と同じ間隔で回すと
 * レート消費が読めなくなる。画面を開いたときとユーザーの明示的な更新操作でのみ取得する。
 */
export function useOpenPullRequests(enabled: boolean): UseOpenPullRequestsResult {
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [failedRepositories, setFailedRepositories] = useState<string[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // refreshで再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/pull-requests", { signal: controller.signal });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `リクエストに失敗しました (${res.status})`,
          );
        }
        const data: OpenPullRequestsResponse = await res.json();
        if (cancelled) return;
        setPullRequests(data.pullRequests);
        setFailedRepositories(data.failedRepositories);
        setFetchedAt(data.fetchedAt);
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
  }, [enabled, reloadKey]);

  return { pullRequests, failedRepositories, fetchedAt, isLoading, error, refresh };
}
