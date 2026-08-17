"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import type { AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import type { BranchFlowResponse, RepositoryBranchStatus } from "@/types/branch-flow";

type UseBranchFlowResult = {
  branchStatuses: RepositoryBranchStatus[];
  /** 取得に失敗したリポジトリのfullName（部分的な欠落を画面に出すため） */
  failedRepositories: string[];
  /** 最終取得時刻（ISO8601）。未取得はnull */
  fetchedAt: string | null;
  isLoading: boolean;
  /**
   * 取得が飛んでいる間は自動更新でも真になる（#1767）。読み込み表示（更新ボタンの無効化・
   * 「読み込み中...」）は`isLoading`のまま据え置き、更新アイコンの回転だけをこちらで出す。
   */
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * リポジトリ横断のブランチ状況を取得する（#1455）。
 *
 * **自動更新は`autoRefreshIntervalMs`が渡されている間だけ**（#1767。既定は「自動更新しない」で、
 * 間隔はブランチ画面のメニューでユーザーが選ぶ）。1回の取得でリポジトリあたり1回GraphQLを
 * 消費し、同じ画面のPR一覧（`use-pull-requests.ts`）もあわせて動くため、短い間隔で回すほど
 * レート制限を使う。取得のきっかけはこのほかに「フロー画面を開いたとき」と更新ボタン。
 *
 * `enabled`がfalseの間は取得しない（自動更新も止まる）。左メニューに件数を出すPR一覧と違い、
 * この画面の情報は画面を開くまで誰も見ないので、開いていないときにまで消費する理由が無い。
 * **一度取得した内容は`enabled`がfalseに戻っても保持する**（画面を出入りするたびに
 * 取り直すとそれだけでGitHub APIを消費するため）。
 */
export function useBranchFlow(
  enabled: boolean,
  autoRefreshIntervalMs: AutoRefreshIntervalMs = null,
): UseBranchFlowResult {
  const [branchStatuses, setBranchStatuses] = useState<RepositoryBranchStatus[]>([]);
  const [failedRepositories, setFailedRepositories] = useState<string[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // refreshで再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);

  // 自動更新から呼ぶ取得処理。取得effectの中で作った関数をここへ預け、ポーリングのeffectが
  // 取得effectを再実行させずに（＝`isLoading`を立て直さずに）呼べるようにする。
  const backgroundLoadRef = useRef<(() => Promise<void>) | null>(null);
  // 前の取得が飛んでいる間は次を投げない。遅い応答が重なるとGitHub APIを無駄に消費する。
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();

    /**
     * `background`が真なのは自動更新からの呼び出し（#1767）。読み込み表示を出さず、失敗も
     * 画面に出さない——周期ごとに更新ボタンが無効化され「読み込み中...」が点滅するのは
     * 画面を見ている側にとって邪魔で、瞬断は次の周期で回復するため（PR一覧と同じ扱い）。
     */
    async function load(background: boolean) {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // 更新アイコンの回転は自動更新でも出す（#1767）
      setIsRefreshing(true);
      if (!background) {
        setIsLoading(true);
        setError(null);
      }
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
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled || background) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
        if (!cancelled) {
          setIsRefreshing(false);
          if (!background) setIsLoading(false);
        }
      }
    }

    backgroundLoadRef.current = () => load(true);
    load(false);

    return () => {
      cancelled = true;
      controller.abort();
      backgroundLoadRef.current = null;
    };
  }, [enabled, reloadKey]);

  // 画面を開いていない間は自動更新しない（`enabled`がfalseなら取得関数も外れている）。
  useAutoRefresh(enabled ? autoRefreshIntervalMs : null, backgroundLoadRef);

  return { branchStatuses, failedRepositories, fetchedAt, isLoading, isRefreshing, error, refresh };
}
