"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveDeployState } from "@/lib/branch-flow";
import type { BranchFlowDeployResponse, RepositoryDeployStatus } from "@/types/branch-flow";

type UseDeployStatusResult = {
  deployStatuses: RepositoryDeployStatus[];
  /** 最終取得時刻（ISO8601）。未取得はnull */
  fetchedAt: string | null;
  refresh: () => void;
};

/** デプロイが動いている間の再取得間隔（ミリ秒） */
const ACTIVE_POLL_INTERVAL_MS = 30_000;

/** まだ本番へ出ていない（＝追いかける意味がある）リポジトリがあるか */
function hasPendingDeploy(
  statuses: RepositoryDeployStatus[],
  releaseMergedAtByRepository: Map<string, string>,
): boolean {
  const now = Date.now();
  return statuses.some((status) => {
    const state = resolveDeployState({
      deployRun: status.deployRun,
      releaseMergedAt: releaseMergedAtByRepository.get(status.repositoryFullName) ?? null,
      now,
    });
    return state !== null && state.kind !== "success";
  });
}

/**
 * リポジトリ横断の本番デプロイ状況を取得する（#1579）。
 *
 * 「ブランチとPRの流れ」画面はもともと自動更新を持たない（開いたときと「更新」ボタンのときだけ）。
 * **例外として、デプロイが動いている間だけこの取得を30秒ごとに回す。** マージ直後の
 * 「本番へデプロイ中」が押さないと「デプロイ成功」へ変わらないのでは、この画面を見て
 * 「マージが完了してデプロイされたのか」を判断できないため（Issue #1579）。
 *
 * 回すのは**この取得だけ**で、ブランチ状況（`/api/branch-flow`）とPR一覧は従来どおり手動更新のまま。
 * こちらの消費はリポジトリあたりREST 1回で、しかもETagの条件付きGETを通すため、実行が進んで
 * いない間はGitHubのレート制限を消費しない。
 *
 * **本番へ出たと分かった時点でポーリングを止める。** 次のデプロイは新しいリリースのマージから
 * 始まり、そのきっかけ（この画面のマージボタン・「更新」）は必ず`refresh()`を通るため、
 * 止めたまま取り残されることはない。
 *
 * 取得に失敗しても画面にエラーを出さない。デプロイの状態が分からないだけで、リリースの束は
 * 従来どおりの表示に戻るため（**間違った状態を出すより「何も言わない」方がよい**）。
 */
export function useDeployStatus(
  enabled: boolean,
  /** リポジトリごとの直近のリリースのマージ時刻（`latestReleaseMergedAtByRepository`） */
  releaseMergedAtByRepository: Map<string, string>,
): UseDeployStatusResult {
  const [deployStatuses, setDeployStatuses] = useState<RepositoryDeployStatus[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  // refreshで再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);
  // ポーリングを続けるかの判定にだけ使う。PR一覧が更新されるたびにポーリングを
  // 貼り直さないよう、依存配列ではなくrefで受け渡す。
  const releaseMergedAtRef = useRef(releaseMergedAtByRepository);

  useEffect(() => {
    releaseMergedAtRef.current = releaseMergedAtByRepository;
  }, [releaseMergedAtByRepository]);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    /** 取得中かどうか。タブ復帰時の即時取得が二重に走るのを防ぐ */
    let inFlight = false;
    /** 直近の取得結果。次のポーリングを行うかの判断に使う */
    let lastStatuses: RepositoryDeployStatus[] = [];
    const controller = new AbortController();

    async function load() {
      inFlight = true;
      try {
        const res = await fetch("/api/branch-flow/deploy", { signal: controller.signal });
        if (!res.ok) return;
        const data: BranchFlowDeployResponse = await res.json();
        if (cancelled) return;
        lastStatuses = data.repositories;
        setDeployStatuses(data.repositories);
        setFetchedAt(data.fetchedAt);
      } catch {
        // 前回の取得結果を保ったままにする（失敗を理由に表示を消さない）
      } finally {
        inFlight = false;
      }
    }

    function schedule() {
      if (cancelled || !hasPendingDeploy(lastStatuses, releaseMergedAtRef.current)) return;
      timerId = setTimeout(poll, ACTIVE_POLL_INTERVAL_MS);
    }

    async function poll() {
      // バックグラウンドタブでは取得せず次の周期だけ進める（復帰時にvisibilitychangeで即時取得する）
      if (!document.hidden) await load();
      schedule();
    }

    function handleVisibilityChange() {
      if (document.hidden || inFlight) return;
      if (!hasPendingDeploy(lastStatuses, releaseMergedAtRef.current)) return;
      clearTimeout(timerId);
      void poll();
    }

    void load().then(schedule);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      controller.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, reloadKey]);

  return { deployStatuses, fetchedAt, refresh };
}
