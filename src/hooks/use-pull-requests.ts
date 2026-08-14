"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  PullRequestListResponse,
  PullRequestListScope,
  PullRequestSummary,
} from "@/types/pull-request";

type UsePullRequestsResult = {
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
 * Pull Requestをリポジトリ横断で取得する。
 *
 * `scope`が`open`ならマージ待ちのPRだけ、`all`ならクローズ済み（マージ済み・却下）も直近ぶんだけ
 * 含める（#1312）。**再取得が走るのは母集団が広がったときだけ**で、「処理中」「完了」の
 * ビュー切り替えは同じ取得結果をクライアント側で絞るだけなのでGitHub APIを叩き直さない。
 *
 * **一度`all`まで広げた母集団は狭めない。** `open`は`all`の部分集合なので、PRペインを離れて
 * 要求が`open`へ戻るたびに取り直すと、ペインを出入りするだけでGitHub APIを消費してしまう（#1389）。
 *
 * **ダッシュボードを開いている間は常に有効で、自動ポーリングは行わない。** 左メニューの件数表示
 * （#1389）のため、PRペインを開いていなくてもマウント時に1回だけ取得する。1回の取得で
 * 「リポジトリ数 + draft以外のopen PR数」ぶんのGitHub APIを消費するため
 * （[/api/pull-requests](../app/api/pull-requests/route.ts)）、他のポーリング系フック
 * （use-pull-request-ci-status等が対象1件を追うのとは規模が違う）と同じ間隔で回すと
 * レート消費が読めなくなる。画面を開いたときとユーザーの明示的な更新操作でのみ取得する。
 */
export function usePullRequests(scope: PullRequestListScope): UsePullRequestsResult {
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [failedRepositories, setFailedRepositories] = useState<string[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // refreshで再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);
  // 実際に取得する母集団。要求が狭まっても`all`のまま据え置く（#1389）。effectで追従させると
  // 狭い方の取得が1回走ってから広げ直すことになるため、レンダー中に調整する
  // （Reactの「propsの変化に合わせてstateを調整する」パターン）。
  const [fetchScope, setFetchScope] = useState<PullRequestListScope>(scope);
  if (scope === "all" && fetchScope === "open") setFetchScope("all");

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/pull-requests?scope=${fetchScope}`, {
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
        const data: PullRequestListResponse = await res.json();
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
  }, [fetchScope, reloadKey]);

  return { pullRequests, failedRepositories, fetchedAt, isLoading, error, refresh };
}
