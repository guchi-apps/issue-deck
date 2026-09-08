"use client";

import { useCallback, useEffect, useState } from "react";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  applyReleaseCheckToggle,
  type ReleaseCheckRecord,
  type ReleaseCheckTargetSummary,
} from "@/lib/release-check";

type ReleaseHistoryResponse = {
  entries: ReleaseHistoryItem[];
  checkTargets?: ReleaseCheckTargetSummary[];
  checkRecords?: ReleaseCheckRecord[];
};

type UseReleaseHistoryResult = {
  entries: ReleaseHistoryItem[] | null;
  /** 動作確認の対象に選んだリポジトリ（#2930） */
  checkTargets: ReleaseCheckTargetSummary[];
  /** 確認済みの記録（#2930） */
  checkRecords: ReleaseCheckRecord[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /** 1件のリリースを確認済み／未確認へ切り替える */
  setReleaseChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => Promise<void>;
  /** リポジトリを動作確認の対象に加える／外す */
  setCheckTarget: (
    repository: { id: string; fullName: string },
    targeted: boolean,
  ) => Promise<void>;
};

/**
 * 「リリース履歴」画面（#2726）のデータ取得。
 *
 * **自動更新は持たない。** リリースは1日に何度も増えるものではないため、`use-session-usage.ts`
 * と同じく画面を開いたときと更新ボタンを押したときにだけ取得する。
 *
 * `enabled`がfalseの間は取得しない（ペインを開いていないときにフェッチしない）。
 *
 * 動作確認のフラグ（#2930）は、**状態へ畳まれていない材料**（対象リポジトリと確認済みの記録）
 * として受け取り、切り替えは楽観的更新にする。畳むのは`lib/release-check.ts`の純粋関数で、
 * 描き直しにサーバーの応答を待たない。失敗したら手元の値を元へ戻す
 * （`issue-deck-shell.tsx`のリポジトリ表示トグルと同じ形）。
 */
export function useReleaseHistory(enabled: boolean): UseReleaseHistoryResult {
  const [entries, setEntries] = useState<ReleaseHistoryItem[] | null>(null);
  const [checkTargets, setCheckTargets] = useState<ReleaseCheckTargetSummary[]>([]);
  const [checkRecords, setCheckRecords] = useState<ReleaseCheckRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/repositories/release-history", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as ReleaseHistoryResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setEntries(json.entries);
        setCheckTargets(json.checkTargets ?? []);
        setCheckRecords(json.checkRecords ?? []);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, reloadKey]);

  const setReleaseChecked = useCallback(
    async (target: { repoFullName: string; tagName: string }, checked: boolean) => {
      const previous = checkRecords;
      setCheckRecords(applyReleaseCheckToggle(previous, target, checked));
      setError(null);

      try {
        const res = await fetch("/api/repositories/release-checks", {
          method: checked ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(target),
        });
        if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
      } catch (err) {
        setCheckRecords(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [checkRecords],
  );

  const setCheckTarget = useCallback(
    async (repository: { id: string; fullName: string }, targeted: boolean) => {
      const previous = checkTargets;
      const rest = previous.filter((entry) => entry.repoFullName !== repository.fullName);
      setCheckTargets(
        targeted
          ? [...rest, { repoFullName: repository.fullName, since: new Date().toISOString() }]
          : rest,
      );
      setError(null);

      try {
        const res = await fetch("/api/repositories/release-checks/targets", {
          method: targeted ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryId: repository.id }),
        });
        if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
        // 基準時刻はサーバーが持つ値が正（押し直しても既存行の時刻は動かない）。
        const json = (await res.json()) as { since?: string };
        if (targeted && json.since) {
          setCheckTargets([...rest, { repoFullName: repository.fullName, since: json.since }]);
        }
      } catch (err) {
        setCheckTargets(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [checkTargets],
  );

  return {
    entries,
    checkTargets,
    checkRecords,
    isLoading,
    error,
    refresh,
    setReleaseChecked,
    setCheckTarget,
  };
}
