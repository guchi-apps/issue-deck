"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  applyReleaseCheckLineToggle,
  applyReleaseCheckToggle,
  isReleaseToggleUnsettled,
  overlayReleaseCheckLineToggles,
  overlayReleaseCheckToggles,
  type PendingReleaseToggle,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
} from "@/lib/release-check";

type ReleaseHistoryResponse = {
  entries: ReleaseHistoryItem[];
  checkRecords?: ReleaseCheckRecord[];
  checkLineRecords?: ReleaseCheckLineRecord[];
};

type CheckTarget = { repoFullName: string; tagName: string };
type CheckLineTarget = CheckTarget & { lineKey: string };

function checkKey(target: CheckTarget): string {
  return `${target.repoFullName} ${target.tagName}`;
}

function checkLineKey(target: CheckLineTarget): string {
  return `${target.repoFullName} ${target.tagName} ${target.lineKey}`;
}

type UseReleaseHistoryResult = {
  entries: ReleaseHistoryItem[] | null;
  /** 確認済みの記録（#2930） */
  checkRecords: ReleaseCheckRecord[];
  /** 箇条書き行ごとの確認記録（#2982） */
  checkLineRecords: ReleaseCheckLineRecord[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /** 1件のリリースを確認済み／未確認へ切り替える */
  setReleaseChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => Promise<void>;
  /** 箇条書き1行を確認済み／未確認へ切り替える（#2982） */
  setReleaseLineChecked: (
    target: { repoFullName: string; tagName: string; lineKey: string },
    checked: boolean,
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
 * 動作確認のフラグ（#2930）のうち**ここが持つのは確認済みの記録だけ**で、対象リポジトリは
 * `ConnectedRepository.releaseCheckSince`（サーバーが描いた時点で入っている）から来る。
 * 記録は状態へ畳まれていない材料のまま受け取り、切り替えは楽観的更新にする。畳むのは
 * `lib/release-check.ts`の純粋関数で、描き直しにサーバーの応答を待たない。失敗したら
 * 手元の値を元へ戻す（`issue-deck-shell.tsx`のリポジトリ表示トグルと同じ形）。
 *
 * **取り直しの応答で切り替えを巻き戻さない**（#3797）。一覧は取り直しの間も前回の値のまま
 * 押せるが、応答の確認記録は取得を始めた時点のDBの値なので、その間に押した切り替えが入って
 * いない。押した操作を`pending*Ref`に持ち、応答へ上乗せしてから状態へ入れる。失敗時の
 * 巻き戻しも、押した時点の記録全体ではなく失敗した1件だけを逆向きに戻す（連続して押した
 * 他の項目まで戻さない）。
 */
export function useReleaseHistory(enabled: boolean): UseReleaseHistoryResult {
  const [entries, setEntries] = useState<ReleaseHistoryItem[] | null>(null);
  const [checkRecords, setCheckRecords] = useState<ReleaseCheckRecord[]>([]);
  const [checkLineRecords, setCheckLineRecords] = useState<ReleaseCheckLineRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 取得の開始と保存の完了に振る通し番号。応答へ上乗せが要るかの判定に使う
  const seqRef = useRef(0);
  const pendingChecksRef = useRef(new Map<string, PendingReleaseToggle<CheckTarget>>());
  const pendingLinesRef = useRef(new Map<string, PendingReleaseToggle<CheckLineTarget>>());

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);
    const fetchStartSeq = ++seqRef.current;

    fetch("/api/repositories/release-history", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as ReleaseHistoryResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setEntries(json.entries);
        // 取得を始める前に保存が済んでいた操作は応答に入っているので手放す
        for (const [key, toggle] of pendingChecksRef.current) {
          if (!isReleaseToggleUnsettled(toggle, fetchStartSeq)) pendingChecksRef.current.delete(key);
        }
        for (const [key, toggle] of pendingLinesRef.current) {
          if (!isReleaseToggleUnsettled(toggle, fetchStartSeq)) pendingLinesRef.current.delete(key);
        }
        setCheckRecords(
          overlayReleaseCheckToggles(json.checkRecords ?? [], pendingChecksRef.current.values()),
        );
        setCheckLineRecords(
          overlayReleaseCheckLineToggles(json.checkLineRecords ?? [], pendingLinesRef.current.values()),
        );
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

  const setReleaseChecked = useCallback(async (target: CheckTarget, checked: boolean) => {
    const key = checkKey(target);
    const toggle: PendingReleaseToggle<CheckTarget> = { target, checked, settledSeq: null };
    pendingChecksRef.current.set(key, toggle);
    setCheckRecords((prev) => applyReleaseCheckToggle(prev, target, checked));
    setError(null);

    try {
      const res = await fetch("/api/repositories/release-checks", {
        method: checked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
      toggle.settledSeq = ++seqRef.current;
    } catch (err) {
      // 後から同じ項目を押し直していれば、そちらの結果を優先する
      if (pendingChecksRef.current.get(key) !== toggle) return;
      pendingChecksRef.current.delete(key);
      setCheckRecords((prev) => applyReleaseCheckToggle(prev, target, !checked));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setReleaseLineChecked = useCallback(async (target: CheckLineTarget, checked: boolean) => {
    const key = checkLineKey(target);
    const toggle: PendingReleaseToggle<CheckLineTarget> = { target, checked, settledSeq: null };
    pendingLinesRef.current.set(key, toggle);
    setCheckLineRecords((prev) => applyReleaseCheckLineToggle(prev, target, checked));
    setError(null);

    try {
      const res = await fetch("/api/repositories/release-check-lines", {
        method: checked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
      toggle.settledSeq = ++seqRef.current;
    } catch (err) {
      if (pendingLinesRef.current.get(key) !== toggle) return;
      pendingLinesRef.current.delete(key);
      setCheckLineRecords((prev) => applyReleaseCheckLineToggle(prev, target, !checked));
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    entries,
    checkRecords,
    checkLineRecords,
    isLoading,
    error,
    refresh,
    setReleaseChecked,
    setReleaseLineChecked,
  };
}
