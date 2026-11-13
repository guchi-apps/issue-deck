"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  applyReleaseCheckLineToggle,
  applyReleaseCheckToggle,
  isReleaseToggleUnsettled,
  overlayReleaseCheckLineToggles,
  overlayReleaseCheckToggles,
  type PendingReleaseToggle,
  type ReleaseCheckLineRecord,
  type ReleaseLineToggleTarget,
  type ReleaseCheckRecord,
} from "@/lib/release-check";
import { applyIosReleaseStatuses, type IosReleaseStatus } from "@/lib/release-history";
import {
  mergeReleaseHistoryByRepository,
  type ReleaseHistoryFreshness,
  type ReleaseHistoryState,
} from "@/lib/release-history-cache";

import { clientErrorMessage } from "@/lib/client-error-message";
type ReleaseHistoryResponse = {
  /** この応答が受け持ったリポジトリ（#5230）。ここに含まれる分だけを差し替える */
  repositories?: string[];
  /** この応答の母集団のうち取得に失敗したリポジトリ。残っている間は最新とみなさない */
  failedRepositories?: string[];
  /** 失敗の原因（403の分類など。#5366） */
  failedReasons?: Record<string, string>;
  entries: ReleaseHistoryItem[];
  checkRecords?: ReleaseCheckRecord[];
  checkLineRecords?: ReleaseCheckLineRecord[];
  /** 取得した時刻。前回の取得結果では最も古いリポジトリの時刻（#5230） */
  fetchedAt?: string | null;
};

type IosStatusResponse = {
  statuses?: IosReleaseStatus[];
  failedRepositories?: string[];
  failedReasons?: Record<string, string>;
};

const RELEASE_FETCH_PARTIAL_ERROR =
  "一部のリポジトリのリリース履歴を取得できませんでした。取得できるまで確認操作はできません。更新ボタンでもう一度取得できます。";

const IOS_STATUS_ERROR = "iOS配布の状況を取得できませんでした。更新ボタンでもう一度取得できます。";

/** 失敗したリポジトリの原因（#5366）を案内文へ添える。原因が無ければ案内文のまま */
function withReasons(message: string, reasons: Record<string, string> | undefined): string {
  const lines = Object.entries(reasons ?? {}).map(([repo, reason]) => `${repo}: ${reason}`);
  return lines.length > 0 ? `${message}（${lines.join(" / ")}）` : message;
}

type CheckTarget = { repoFullName: string; tagName: string };
type CheckLineTarget = ReleaseLineToggleTarget;

function checkKey(target: CheckTarget): string {
  return `${target.repoFullName} ${target.tagName}`;
}

function checkLineKey(target: CheckLineTarget): string {
  return `${target.repoFullName} ${target.tagName} ${target.lineKey}`;
}

/** 項目チェックをGitHub Release本文へ保存できなかった理由（#4374）。保存済みとは表示しない */
function lineSaveErrorMessage(code: string | undefined, status: number): string {
  switch (code) {
    case "permission_denied":
      return "GitHub Releaseを更新する権限がありません。GitHub Appに「Contents: 書き込み」の権限が必要です。";
    case "not_found":
      return "対応するGitHub Releaseが見つかりません。本文へ同期できないため保存していません。";
    case "line_not_found":
    case "conflict":
      return "GitHub Release本文が別で編集されたため保存できませんでした。最新の状態を取り直しました。もう一度操作してください。";
    default:
      return `GitHub Release本文への保存に失敗しました (${code ?? status})。もう一度お試しください。`;
  }
}

/**
 * 段階ごとの応答を重ねる元（#5230）にも行チェックの切り替えを入れておく。入れないと、別のリポジトリの
 * 応答が届いたときにこのリポジトリの行が合成元の古い値へ戻る（保存済みの切り替えは上乗せの対象から外れるため）
 */
function applyLineToggleToHistory(
  historyRef: { current: ReleaseHistoryState | null },
  target: CheckLineTarget,
  checked: boolean,
) {
  const current = historyRef.current;
  if (!current) return;
  historyRef.current = {
    ...current,
    checkLineRecords: applyReleaseCheckLineToggle(current.checkLineRecords, target, checked),
  };
}

type UseReleaseHistoryResult = {
  entries: ReleaseHistoryItem[] | null;
  /** 確認済みの記録（#2930） */
  checkRecords: ReleaseCheckRecord[];
  /** 箇条書き行ごとの確認記録（#2982） */
  checkLineRecords: ReleaseCheckLineRecord[];
  isLoading: boolean;
  /**
   * 一覧の鮮度（#5230）。`stale`の間は前回の取得結果を出しているだけなので、項目チェックを押させない。
   * `partial`は確認対象のリポジトリだけ最新
   */
  freshness: ReleaseHistoryFreshness;
  /** 出している一覧を取得した時刻（ISO文字列）。まだ何も無ければnull */
  fetchedAt: string | null;
  error: string | null;
  /** iOS配布の状況を取得中か（一覧より遅れて届く。#5214） */
  iosStatusLoading: boolean;
  /** iOS配布の状況を取れなかったときの案内（#5214） */
  iosStatusError: string | null;
  refresh: () => void;
  /** 1件のリリースを確認済み／未確認へ切り替える */
  setReleaseChecked: (
    target: { repoFullName: string; tagName: string },
    checked: boolean,
  ) => Promise<void>;
  /** 箇条書き1行を確認済み／未確認へ切り替える（#2982） */
  setReleaseLineChecked: (
    target: ReleaseLineToggleTarget,
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
 *
 * **前回の取得結果を先に出し、最新は2段で重ねる**（#5230）。開いた直後は`release-history/cached`
 * （GitHubを呼ばない）を出し、最新は確認対象のリポジトリ（`scope=targets`）とそれ以外
 * （`scope=others`）を並行して取る。初期表示の「未確認のリリース」は確認対象からしか出ないため、
 * `targets`が届いた時点で初期表示は最新になる。応答はそれぞれが受け持ったリポジトリの分だけを
 * 差し替える（`mergeReleaseHistoryByRepository`）。
 *
 * **iOS配布の状況は一覧を出してから取る**（#5214）。run一覧の取得が最も重いため、一覧の応答から
 * 切り離して後から`entries`へ重ねる。取り直しの間は前回の状況を残し、バッジを点滅させない。
 */
export function useReleaseHistory(enabled: boolean): UseReleaseHistoryResult {
  const [listedEntries, setListedEntries] = useState<ReleaseHistoryItem[] | null>(null);
  const [iosStatuses, setIosStatuses] = useState<IosReleaseStatus[]>([]);
  const [iosStatusLoading, setIosStatusLoading] = useState(false);
  const [iosStatusError, setIosStatusError] = useState<string | null>(null);
  const [checkRecords, setCheckRecords] = useState<ReleaseCheckRecord[]>([]);
  const [checkLineRecords, setCheckLineRecords] = useState<ReleaseCheckLineRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [freshness, setFreshness] = useState<ReleaseHistoryFreshness>("stale");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  // 段階ごとの応答を重ねる元（#5230）。描画用の状態とは別に持ち、応答の到着順に依らず最新から合成する
  const historyRef = useRef<ReleaseHistoryState | null>(null);

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
    setIosStatusLoading(false);
    setIosStatusError(null);
    const fetchStartSeq = ++seqRef.current;

    // 前回の取得結果は、まだ何も出していないときだけ取りに行く（#5230）。取り直し（更新ボタン）では
    // 手元の一覧のほうが新しいので使わない
    const wantCached = historyRef.current === null;
    let freshApplied = false;
    let targetsDone = false;
    let othersDone = false;

    function apply(json: ReleaseHistoryResponse) {
      // 取得を始める前に保存が済んでいた操作は応答に入っているので手放す
      for (const [key, toggle] of pendingChecksRef.current) {
        if (!isReleaseToggleUnsettled(toggle, fetchStartSeq)) pendingChecksRef.current.delete(key);
      }
      for (const [key, toggle] of pendingLinesRef.current) {
        if (!isReleaseToggleUnsettled(toggle, fetchStartSeq)) pendingLinesRef.current.delete(key);
      }
      // 受け持ったリポジトリの分だけ差し替える。`repositories`が無い応答（旧形式）は全体の差し替え
      const next = json.repositories
        ? mergeReleaseHistoryByRepository(historyRef.current, {
            repositories: json.repositories,
            entries: json.entries,
            checkLineRecords: json.checkLineRecords ?? [],
          })
        : { entries: json.entries, checkLineRecords: json.checkLineRecords ?? [] };
      historyRef.current = next;
      setListedEntries(next.entries);
      setCheckRecords(overlayReleaseCheckToggles(json.checkRecords ?? [], pendingChecksRef.current.values()));
      setCheckLineRecords(
        overlayReleaseCheckLineToggles(next.checkLineRecords, pendingLinesRef.current.values()),
      );
      if (json.fetchedAt) setFetchedAt(json.fetchedAt);
    }

    function getJson(url: string): Promise<ReleaseHistoryResponse> {
      return fetch(url, { signal: controller.signal }).then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as ReleaseHistoryResponse;
      });
    }

    function onFailed(err: unknown) {
      if (cancelled || controller.signal.aborted) return;
      setError(clientErrorMessage(err));
    }

    if (wantCached) {
      getJson("/api/repositories/release-history/cached")
        .then((json) => {
          // 最新が先に届いていれば、前回の値で上書きしない
          if (cancelled || freshApplied || !json.fetchedAt) return;
          apply(json);
          setFreshness("stale");
        })
        // 前回の値が取れなくても最新を待てばよいので、案内は出さない
        .catch(() => {});
    }

    function settle() {
      setFreshness(targetsDone ? (othersDone ? "fresh" : "partial") : "stale");
    }

    const targets = getJson("/api/repositories/release-history?scope=targets")
      .then((json) => {
        if (cancelled) return;
        freshApplied = true;
        apply(json);
        // 失敗した確認対象が残る間は前回の値のままなので、staleを保ち確認操作をロックする
        const failed = json.failedRepositories ?? [];
        if (failed.length > 0) {
          setError(withReasons(RELEASE_FETCH_PARTIAL_ERROR, json.failedReasons));
          // 取り直しの失敗で、直前のfreshのまま確認操作が通らないようにする
          setFreshness("stale");
          return;
        }
        targetsDone = true;
        settle();
      })
      .catch((err) => {
        onFailed(err);
        if (!cancelled) setFreshness("stale");
      });
    const others = getJson("/api/repositories/release-history?scope=others")
      .then((json) => {
        if (cancelled) return;
        freshApplied = true;
        othersDone = true;
        apply(json);
        if ((json.failedRepositories ?? []).length > 0) setError(withReasons(RELEASE_FETCH_PARTIAL_ERROR, json.failedReasons));
        // 確認対象がまだなら、一覧は前回の値の混ざったままなので押せる状態にしない
        if (targetsDone) settle();
      })
      .catch(onFailed);

    void Promise.all([targets, others]).then(() => {
      if (cancelled) return;
      setIsLoading(false);
      if (!targetsDone && !othersDone) return;

      // 一覧の表示を待たせないよう、一覧が揃ってから取りに行く
      setIosStatusLoading(true);
      void fetch("/api/repositories/release-history/ios-status", { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
          return (await res.json()) as IosStatusResponse;
        })
        .then((ios) => {
          if (cancelled) return;
          const failed = new Set(ios.failedRepositories ?? []);
          // 取れなかったリポジトリは前回の状況を残す
          setIosStatuses((prev) => [
            ...prev.filter((status) => failed.has(status.repoFullName)),
            ...(ios.statuses ?? []),
          ]);
          setIosStatusError(failed.size > 0 ? withReasons(IOS_STATUS_ERROR, ios.failedReasons) : null);
        })
        .catch(() => {
          if (cancelled || controller.signal.aborted) return;
          setIosStatusError(IOS_STATUS_ERROR);
        })
        .finally(() => {
          if (!cancelled) setIosStatusLoading(false);
        });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, reloadKey]);

  const entries = useMemo(
    () => (listedEntries ? applyIosReleaseStatuses(listedEntries, iosStatuses) : null),
    [listedEntries, iosStatuses],
  );

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
      setError(clientErrorMessage(err));
    }
  }, []);

  const setReleaseLineChecked = useCallback(async (target: CheckLineTarget, checked: boolean) => {
    const key = checkLineKey(target);
    const toggle: PendingReleaseToggle<CheckLineTarget> = { target, checked, settledSeq: null };
    pendingLinesRef.current.set(key, toggle);
    setCheckLineRecords((prev) => applyReleaseCheckLineToggle(prev, target, checked));
    applyLineToggleToHistory(historyRef, target, checked);
    setError(null);

    try {
      const res = await fetch("/api/repositories/release-check-lines", {
        method: checked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!res.ok) {
        const json: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(lineSaveErrorMessage(json.error, res.status));
      }
      toggle.settledSeq = ++seqRef.current;
    } catch (err) {
      if (pendingLinesRef.current.get(key) !== toggle) return;
      pendingLinesRef.current.delete(key);
      setCheckLineRecords((prev) => applyReleaseCheckLineToggle(prev, target, !checked));
      applyLineToggleToHistory(historyRef, target, !checked);
      setError(clientErrorMessage(err));
      // GitHub本文が正なので、失敗したときは本文の最新状態を取り直して画面を揃える（同時編集の反映）
      refresh();
    }
  }, [refresh]);

  return {
    entries,
    checkRecords,
    checkLineRecords,
    isLoading,
    freshness,
    fetchedAt,
    error,
    iosStatusLoading,
    iosStatusError,
    refresh,
    setReleaseChecked,
    setReleaseLineChecked,
  };
}
