"use client";

import { useEffect, useState } from "react";

import { parsePullRequestId } from "@/lib/github-reference";
import { isPendingPullRequestDeployStatus } from "@/lib/pull-request-deploy";
import type { DeployFailureIssueRef } from "@/types/branch-flow";
import type {
  PullRequestDeployStatus,
  PullRequestDeployStatusResponse,
} from "@/types/pull-request";

/** デプロイが動いている間の再取得間隔（ミリ秒）。ブランチ画面（#1579）と揃える */
const ACTIVE_POLL_INTERVAL_MS = 30_000;

export type PullRequestDeployStatusResult = {
  status: PullRequestDeployStatus | null;
  /** そのリポジトリで開いているデプロイ失敗Issue（#2236）。無ければnull */
  failureIssue: DeployFailureIssueRef | null;
};

const EMPTY_RESULT: PullRequestDeployStatusResult = { status: null, failureIssue: null };

/**
 * 選択中PRが本番へ届いたかを取得する（#1814）。
 *
 * **取りに行くのはマージ済みのPRだけ。** 未マージのPRに出す状態が無く、開くたびにGitHub APIを
 * 消費する意味もないため。PR詳細（`use-pull-request-detail.ts`）と同じく既定ではポーリングせず、
 * **デプロイ待ち・デプロイ中のあいだだけ30秒ごとに取り直す**（マージ直後の「デプロイ中」が
 * 押さないと「本番反映済み」に変わらないのでは、この画面で見届けられないため）。
 * バックグラウンドタブでは取得を飛ばし、復帰した時点で取り直す。
 *
 * 取得に失敗しても画面にエラーを出さない（バッジが出ないだけ）。**間違った状態を出すより
 * 「何も言わない」方がよい**という方針をブランチ画面から引き継いでいる。
 *
 * 併せて、そのリポジトリで開いているデプロイ失敗Issue（#2236）も返す。失敗しているときに
 * 「デプロイ失敗 #312」へ移れるようにするためで、**同じ1リクエストで受け取る**
 * （issue-deck自身のDBを引くだけなのでGitHub APIは増えない）。
 */
export function usePullRequestDeployStatus(
  /** PRのid（`<owner>/<repo>#<番号>`）。未選択ならnull */
  pullRequestId: string | null,
  /** マージ済みのPRか。未マージなら取得しない */
  merged: boolean,
  /** 詳細の取得時刻。ヘッダーの「更新」を押したときにこちらも取り直すためのキー */
  refreshKey?: string | null,
): PullRequestDeployStatusResult {
  // どのPRの結果かを一緒に持つ。別のPRへ切り替えた直後に前のPRのバッジを出さないためで、
  // 「更新」での取り直し（refreshKeyの変化）ではidが変わらないためバッジが消えない。
  const [result, setResult] = useState<
    ({ pullRequestId: string } & PullRequestDeployStatusResult) | null
  >(null);

  useEffect(() => {
    const parsed = pullRequestId ? parsePullRequestId(pullRequestId) : null;
    if (!parsed || !merged) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    /** 取得中かどうか。タブ復帰時の即時取得が二重に走るのを防ぐ */
    let inFlight = false;
    /** 直近の取得結果。次のポーリングを行うかの判断に使う */
    let lastStatus: PullRequestDeployStatus | null = null;
    const controller = new AbortController();

    async function load() {
      if (!parsed || !pullRequestId) return;
      inFlight = true;
      try {
        const [owner, repo] = parsed.repositoryFullName.split("/");
        const params = new URLSearchParams({ owner, repo, number: String(parsed.number) });
        const res = await fetch(`/api/pull-requests/deploy-status?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: PullRequestDeployStatusResponse = await res.json();
        if (cancelled) return;
        lastStatus = data.status;
        setResult({
          pullRequestId,
          status: data.status,
          failureIssue: data.failureIssue ?? null,
        });
      } catch {
        // 前回の取得結果を保ったままにする（失敗を理由に表示を消さない）
      } finally {
        inFlight = false;
      }
    }

    function schedule() {
      if (cancelled || !isPendingPullRequestDeployStatus(lastStatus)) return;
      timerId = setTimeout(poll, ACTIVE_POLL_INTERVAL_MS);
    }

    async function poll() {
      if (!document.hidden) await load();
      schedule();
    }

    function handleVisibilityChange() {
      if (document.hidden || inFlight) return;
      if (!isPendingPullRequestDeployStatus(lastStatus)) return;
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
  }, [pullRequestId, merged, refreshKey]);

  return result !== null && result.pullRequestId === pullRequestId ? result : EMPTY_RESULT;
}
