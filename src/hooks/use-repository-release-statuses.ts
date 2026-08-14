"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CiState } from "@/lib/github/release-api";
import type {
  ReleaseButtonStatus,
  ReleaseMergeTarget,
} from "@/lib/github/release-button-status";

export type { ReleaseMergeTarget };

export type ReleasePendingMerge = {
  mergeTarget: ReleaseMergeTarget;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
  /** マージ対象PRのCI状態。`failure`は「マージ待ち」ではなく修正が要ることを示す（#1059） */
  ciState: CiState;
};

/** `/api/repositories/release-pending-merges`が返すリポジトリ1件ぶんのリリース状況（#1117） */
export type RepositoryReleaseStatus = {
  repoFullName: string;
  status: ReleaseButtonStatus;
  /** `error`のとき、どちらの実行が失敗しているか */
  failedWorkflow: "deploy" | "release" | null;
  /** 人のマージ操作を待っているPR。待っていなければnull */
  pendingMerge: ReleasePendingMerge | null;
};

/**
 * ヘッダーの常時表示アイコンでのバックグラウンド再取得間隔（#979）。`useReleaseStatus`のような
 * 常時ポーリングはリポジトリ数分のAPI消費が積み重なるため、短くしすぎない。
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

type Options = {
  /** 動いているリポジトリが1つも無いときの再取得間隔 */
  intervalMs?: number;
  /**
   * 動いているリポジトリ（＝APIが1件でも返した状態）があるときの再取得間隔。
   * 渡さない場合は`intervalMs`のまま短くしない。進捗を見に来ている画面だけが渡す（#1117）。
   */
  activeIntervalMs?: number;
};

/**
 * 全リポジトリ分のリリース状況（実行中・マージ待ち・失敗）を取得する。`idle`のリポジトリは
 * APIが返さないため、配列が空＝動いているものが無い、として扱える。
 * `enabled`の間は表示直後に1回取得し、以後は上記の間隔でバックグラウンド再取得する。
 * `refetch`はポップオーバーを開いたときなどの即時再取得に使う。
 */
export function useRepositoryReleaseStatuses(enabled: boolean, options: Options = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, activeIntervalMs } = options;
  const [data, setData] = useState<RepositoryReleaseStatus[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<RepositoryReleaseStatus[] | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/repositories/release-pending-merges");
      if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
      const json = (await res.json()) as { releaseStatuses: RepositoryReleaseStatus[] };
      if (mountedRef.current) setData(json.releaseStatuses);
      return json.releaseStatuses;
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    /** 直近の取得結果。次の再取得までの間隔の決定に使う */
    let lastStatuses: RepositoryReleaseStatus[] | null = null;

    function schedule() {
      if (cancelled) return;
      // 取得に失敗した場合は直前の状態を保ったまま間隔を決める（失敗を理由に間隔を変えない）。
      const active = activeIntervalMs != null && (lastStatuses?.length ?? 0) > 0;
      timerId = setTimeout(tick, active ? activeIntervalMs : intervalMs);
    }

    async function runOnce() {
      lastStatuses = (await load()) ?? lastStatuses;
      schedule();
    }

    function tick() {
      // バックグラウンドタブでは取得しない（復帰後の次の周期で取得される）
      if (document.hidden) {
        timerId = setTimeout(tick, intervalMs);
        return;
      }
      void runOnce();
    }

    void runOnce();

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [enabled, intervalMs, activeIntervalMs, load]);

  return { data, isLoading, error, refetch: load };
}
