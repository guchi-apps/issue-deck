"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ISSUE_POLL_INTERVAL_MS, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { Issue } from "@/types/issue";

export type IssuePollingHandle = {
  /**
   * いますぐ取り直す。一覧を下へ引っ張ったとき（#1893）や、通知ベルを開いている間の
   * 自動更新（`notification-state.tsx`、#1909）が使う。**ポーリングと違い
   * `document.hidden`では止めない**——見ていない画面のための取得ではないため。
   * 戻り値は取得できたかどうかで、呼んだ側が「いつ時点の内容か」を出すのに使う——
   * 失敗を成功として数えると、取れていないのに「たった今更新」と出てしまう。
   */
  refresh: () => Promise<boolean>;
  /**
   * 最終取得時刻（ISO8601）。未取得はnull。PR一覧（`use-pull-requests.ts`）・
   * ブランチ状況（`use-branch-flow.ts`）と同じ形でヘッダーの「HH:MM時点」に使う（#1797）。
   *
   * **取れなかった周回では更新しない。** 失敗は握り潰して次の周回で回復させる作りなので、
   * 叩いた時刻を入れると、取れていないのに「たった今」と出てしまう。
   */
  fetchedAt: string | null;
  /** 自動更新が有効か（#1797）。この一覧は常時有効なので常に真 */
  autoRefresh: boolean;
  /** 自動更新の間隔（#1797）。画面に出す間隔もこの値を使い、実際の周期とずれないようにする */
  pollIntervalMs: AutoRefreshIntervalMs;
};

/**
 * Issue一覧をDBから取り直し続ける（叩き先は`GET /api/issues`で、GitHub APIは消費しない）。
 */
export function useIssuePolling(
  onIssues: (issues: Issue[]) => void,
  /**
   * 一覧の初期値（サーバー側で描いた`initialIssues`）をいつ取ったか（#1797）。
   *
   * このフックは10秒後の初回ポーリングまで取りに行かないため、渡さないと開いてから
   * 10秒間だけヘッダーの「HH:MM時点」が出ない。**クライアント側で現在時刻を作らない**のは、
   * 初期描画でサーバーと食い違うとハイドレーションが崩れるため。
   */
  initialFetchedAt: string | null = null,
): IssuePollingHandle {
  const onIssuesRef = useRef(onIssues);
  const mountedRef = useRef(true);
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt);

  useEffect(() => {
    onIssuesRef.current = onIssues;
  }, [onIssues]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 前回受け取った一覧のETag（#3387）。次の取得で`If-None-Match`に載せ、変わっていなければ
   * 304で本文を受け取らずに済ませる。初期値（サーバー側で描いた一覧）のETagは持っていない
   * ので、最初の1回だけはまるごと受け取る。
   */
  const etagRef = useRef<string | null>(null);
  /**
   * 飛んでいる取得（#3387）。遅い回線で1回の取得が10秒を超えると、次の周回が同じ大きな一覧を
   * 重ねて取りに行ってしまうため、飛んでいる間は新しく投げずにその完了を待つ。
   */
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetchWithTimeout("/api/issues", {
        // 前回の一覧は手元にあるので、ブラウザのHTTPキャッシュを挟まず304をそのまま受け取る
        cache: "no-store",
        headers: etagRef.current ? { "If-None-Match": etagRef.current } : undefined,
      });
      const headerFetchedAt = res.headers.get("x-fetched-at");
      if (res.status === 304) {
        // 内容は手元と同じ。一覧は渡し直さず（再描画させず）、取得時刻だけを進める
        if (mountedRef.current) setFetchedAt(headerFetchedAt ?? new Date().toISOString());
        return true;
      }
      if (!res.ok) return false;
      const data: { issues: Issue[]; fetchedAt?: string } = await res.json();
      etagRef.current = res.headers.get("etag");
      if (mountedRef.current) {
        onIssuesRef.current(data.issues);
        setFetchedAt(data.fetchedAt ?? headerFetchedAt ?? new Date().toISOString());
      }
      return true;
    } catch {
      // ネットワーク瞬断・タイムアウト等は次回のポーリングで回復するため無視する
      return false;
    }
  }, []);

  const refresh = useCallback((): Promise<boolean> => {
    const inFlight = inFlightRef.current;
    if (inFlight) return inFlight;
    const started = load().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = started;
    return started;
  }, [load]);

  useEffect(() => {
    function poll() {
      if (document.hidden) return;
      void refresh();
    }

    const intervalId = setInterval(poll, ISSUE_POLL_INTERVAL_MS);

    function handleVisibilityChange() {
      // バックグラウンドタブでは`poll`がno-opのままインターバルだけ進むため、
      // 復帰時に次の周期を待たず即座に最新状態を取得する
      if (!document.hidden) poll();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  return {
    refresh,
    fetchedAt,
    // この一覧だけは間隔を選ばせず常時回す（`ISSUE_POLL_INTERVAL_MS`のコメント）。
    // それでも「自動更新しているか」を返すのは、画面側の出し方を他の一覧とそろえるため（#1797）
    autoRefresh: true,
    pollIntervalMs: ISSUE_POLL_INTERVAL_MS,
  };
}
