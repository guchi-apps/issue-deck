"use client";

import { useCallback, useEffect, useState } from "react";

import type { BranchFlowResponse, RepositoryBranchStatus } from "@/types/branch-flow";

type UseBranchFlowResult = {
  branchStatuses: RepositoryBranchStatus[];
  /** 取得に失敗したリポジトリのfullName（部分的な欠落を画面に出すため） */
  failedRepositories: string[];
  /** 最終取得時刻（ISO8601）。未取得はnull */
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * リポジトリ横断のブランチ状況を取得する（#1455）。
 *
 * **画面を開いている間だけ取得し、自動ポーリングは行わない。** 1回の取得でリポジトリあたり
 * 2回（ブランチ一覧＋develop/mainの差分）GitHub APIを消費するため、PR一覧（`use-pull-requests.ts`）
 * と同じ扱いにしている。取得のきっかけは「フロー画面を開いたとき」と更新ボタンだけ。
 *
 * `enabled`がfalseの間は取得しない。左メニューに件数を出すPR一覧と違い、この画面の情報は
 * 画面を開くまで誰も見ないので、開いていないときにまで消費する理由が無い。
 * **一度取得した内容は`enabled`がfalseに戻っても保持する**（画面を出入りするたびに
 * 取り直すとそれだけでGitHub APIを消費するため）。
 */
export function useBranchFlow(enabled: boolean): UseBranchFlowResult {
  const [branchStatuses, setBranchStatuses] = useState<RepositoryBranchStatus[]>([]);
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
        const res = await fetch("/api/branch-flow", { signal: controller.signal });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `リクエストに失敗しました (${res.status})`,
          );
        }
        const data: BranchFlowResponse = await res.json();
        if (cancelled) return;
        setBranchStatuses(data.repositories);
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

  return { branchStatuses, failedRepositories, fetchedAt, isLoading, error, refresh };
}
