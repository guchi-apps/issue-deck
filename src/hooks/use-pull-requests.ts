"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  PullRequestListResponse,
  PullRequestListScope,
  PullRequestSummary,
} from "@/types/pull-request";

/** 自動更新の間隔（#1531）。消費が想定より減らないときはここだけを調整する */
const POLL_INTERVAL_MS = 10_000;

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
 * **ダッシュボードを開いている間は常に有効。** 左メニューの件数表示（#1389）のため、PRペインを
 * 開いていなくてもマウント時に1回だけ取得する。
 *
 * **自動更新は`autoRefresh`が有効な間だけ**（#1531。呼び出し側で「完了したPR」ビューの表示中に
 * 限っている）。1回の取得で「リポジトリ数 + draft以外のopen PR数」ぶんGitHub APIを呼ぶため
 * （[/api/pull-requests](../app/api/pull-requests/route.ts)）、常時ポーリングするとインストール
 * 当たりの上限（5,000回/時）を超える。10秒間隔で回せるのは、取得側がETagの条件付きGETを
 * 通していて変化が無い間は304＝レート制限を消費しないため
 * （[lib/github/conditional-request.ts](../lib/github/conditional-request.ts)）。
 */
export function usePullRequests(
  scope: PullRequestListScope,
  autoRefresh = false,
): UsePullRequestsResult {
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

  // 自動更新から呼ぶ取得処理。取得effectの中で作った関数をここへ預け、ポーリングのeffectが
  // 取得effectを再実行させずに（＝`isLoading`を立て直さずに）呼べるようにする。
  const backgroundLoadRef = useRef<(() => Promise<void>) | null>(null);
  // 前の取得が飛んでいる間は次を投げない。遅い応答が重なるとGitHub APIを無駄に消費する。
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    /**
     * `background`が真なのは自動更新からの呼び出し（#1531）。読み込み表示を出さず、失敗も
     * 画面に出さない——10秒ごとに更新ボタンが無効化され「読み込み中...」が点滅するのは
     * 画面を見ている側にとって邪魔で、瞬断は次の周期で回復するため。
     */
    async function load(background: boolean) {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (!background) {
        setIsLoading(true);
        setError(null);
      }
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
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled || background) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
        if (!cancelled && !background) setIsLoading(false);
      }
    }

    backgroundLoadRef.current = () => load(true);
    load(false);

    return () => {
      cancelled = true;
      controller.abort();
      backgroundLoadRef.current = null;
    };
  }, [fetchScope, reloadKey]);

  useEffect(() => {
    if (!autoRefresh) return;

    function poll() {
      // 裏に回っているタブのために取り続けない。
      if (document.hidden) return;
      void backgroundLoadRef.current?.();
    }

    // 有効になった直後に1回取る。ビューを開いた時点の内容が最長10秒古いままにならないようにする
    // （変化が無ければ304で返るため、この1回でレート制限は消費しない）。
    poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);

    function handleVisibilityChange() {
      // バックグラウンドタブでは`poll`がno-opのままインターバルだけ進むため、
      // 復帰時に次の周期を待たず即座に最新状態を取得する。
      if (!document.hidden) poll();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh]);

  return { pullRequests, failedRepositories, fetchedAt, isLoading, error, refresh };
}
