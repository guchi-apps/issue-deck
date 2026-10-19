"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  hasMoreHistory,
  INITIAL_HISTORY_CURSOR,
  type BranchFlowHistoryCursor,
  type BranchFlowHistoryResponse,
} from "@/lib/branch-flow-history";
import { fetchWithTimeout, SLOW_FETCH_TIMEOUT_MS } from "@/lib/fetch-with-timeout";
import type { PullRequestSummary } from "@/types/pull-request";

/** 「過去のリリース」の追加取得の、1リポジトリぶんの状態（#4844） */
export type BranchFlowHistoryStatus = {
  /** まだ取りに行ける続きがあるか。一度も取っていない間は「あるかもしれない」としてtrue */
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

type RepositoryHistory = {
  pullRequests: PullRequestSummary[];
  cursor: BranchFlowHistoryCursor;
  mainOldestCreatedAt: string | null;
  loading: boolean;
  error: string | null;
};

export type UseBranchFlowHistoryResult = {
  /** 追加取得した全リポジトリぶんのPR。母集団へは`mergeHistoryPullRequests`で足す */
  pullRequests: PullRequestSummary[];
  statusFor: (repositoryFullName: string) => BranchFlowHistoryStatus;
  loadMore: (repositoryFullName: string) => void;
};

const INITIAL_STATUS: BranchFlowHistoryStatus = { hasMore: true, loading: false, error: null };

/**
 * ブランチ画面の「過去のリリース」で、古い版をGitHubから取り足す（#4844）。
 *
 * **押したときだけ取りに行く。** 画面を開いたときの取得量は変えない。取った分は画面の状態に
 * だけ持ち、開き直したら（このフックが作り直されたら）最初から取り直す。
 */
export function useBranchFlowHistory(): UseBranchFlowHistoryResult {
  const [histories, setHistories] = useState<Map<string, RepositoryHistory>>(new Map());
  // 連打で同じページを二重に取らないよう、取得中のリポジトリを同期的に持つ
  const inFlight = useRef<Set<string>>(new Set());
  // 押下時に次のページ番号を同期的に読むための写し。書き換えは`update`だけが行う
  const historiesRef = useRef(histories);

  const loadMore = useCallback((repositoryFullName: string) => {
    if (inFlight.current.has(repositoryFullName)) return;
    const current = historiesRef.current.get(repositoryFullName);
    const cursor = current?.cursor ?? INITIAL_HISTORY_CURSOR;
    if (!hasMoreHistory(cursor)) return;
    inFlight.current.add(repositoryFullName);

    const update = (patch: (prev: RepositoryHistory) => RepositoryHistory) => {
      const next = new Map(historiesRef.current);
      next.set(
        repositoryFullName,
        patch(
          historiesRef.current.get(repositoryFullName) ?? {
            pullRequests: [],
            cursor: INITIAL_HISTORY_CURSOR,
            mainOldestCreatedAt: null,
            loading: false,
            error: null,
          },
        ),
      );
      historiesRef.current = next;
      setHistories(next);
    };

    update((prev) => ({ ...prev, loading: true, error: null }));

    const params = new URLSearchParams({ repo: repositoryFullName });
    if (cursor.developPage !== null) params.set("developPage", String(cursor.developPage));
    if (cursor.mainPage !== null) params.set("mainPage", String(cursor.mainPage));
    if (current?.mainOldestCreatedAt) params.set("mainOldest", current.mainOldestCreatedAt);

    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/branch-flow/history?${params.toString()}`, {
          timeoutMs: SLOW_FETCH_TIMEOUT_MS,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: BranchFlowHistoryResponse = await res.json();
        update((prev) => ({
          pullRequests: [...prev.pullRequests, ...data.pullRequests],
          cursor: data.cursor,
          mainOldestCreatedAt: data.mainOldestCreatedAt,
          loading: false,
          error: null,
        }));
      } catch (error) {
        console.error(`[branch-flow history] ${repositoryFullName}:`, error);
        update((prev) => ({ ...prev, loading: false, error: "過去のリリースを取得できませんでした" }));
      } finally {
        inFlight.current.delete(repositoryFullName);
      }
    })();
  }, []);

  const pullRequests = useMemo(
    () => [...histories.values()].flatMap((history) => history.pullRequests),
    [histories],
  );

  const statusFor = useCallback(
    (repositoryFullName: string): BranchFlowHistoryStatus => {
      const history = histories.get(repositoryFullName);
      if (!history) return INITIAL_STATUS;
      return { hasMore: hasMoreHistory(history.cursor), loading: history.loading, error: history.error };
    },
    [histories],
  );

  return { pullRequests, statusFor, loadMore };
}
