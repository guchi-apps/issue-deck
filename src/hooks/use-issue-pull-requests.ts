"use client";

import { useCallback, useEffect, useState } from "react";

import type { PullRequestLink } from "@/lib/github/pull-request-link";
import { isIssuePullRequestSettling, selectIssuePullRequests } from "@/lib/issue-pull-requests";
import type { IssuePullRequest, IssuePullRequestListResponse } from "@/types/pull-request";

const POLL_INTERVAL_MS = 20_000;

const EMPTY: IssuePullRequest[] = [];

type UseIssuePullRequestsResult = {
  pullRequests: IssuePullRequest[];
  /** マージ直後など、GitHub側の状態が変わったときに取り直す */
  refresh: () => void;
};

/**
 * Issueの対応PRのタイトル・状態・CI状態を取得する（#1339。旧`usePullRequestCiStatus`）。
 *
 * 取得は対応PRの番号が変わったときの1回だけで、そのあとポーリングするのは
 * `pollWhileCiRunning`（＝マージ待ち）の間に**まだ状態が動きうるPR**が残っているときに限る
 * （`isIssuePullRequestSettling`）。状態が確定したら自分でポーリングを止める。マージ待ちでない
 * Issueを開いているだけの間はGitHub APIを繰り返し消費しない。
 *
 * **止める条件はCI実行中だけではない**（#2145）。コンフリクトの自動解消はCIが通過したまま
 * 走るため、CIだけを見て止めると解消が終わってもバッジが「自動解消中」のまま固まる。
 */
export function useIssuePullRequests(
  repositoryFullName: string | null,
  issueNumber: number | null,
  links: PullRequestLink[],
  pollWhileCiRunning: boolean,
): UseIssuePullRequestsResult {
  const [pullRequests, setPullRequests] = useState<IssuePullRequest[]>(EMPTY);
  const [reloadToken, setReloadToken] = useState(0);

  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];
  // 配列は毎レンダー新しい参照になるため、依存配列にはクエリ文字列そのものを使う
  const numbersKey = links.map((link) => link.number).join(",");

  useEffect(() => {
    if (!owner || !repo || !issueNumber || numbersKey === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPullRequests(EMPTY);
      return;
    }

    // 効果の中で絞り込みに使うため、ガードで確定した値を取り出しておく
    const targetIssueNumber = issueNumber;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const controller = new AbortController();

    async function load(fromPolling: boolean) {
      // 裏に回っているタブのために取り続けない。初回だけは表示に必要なので取りに行く
      if (fromPolling && document.hidden) return;
      try {
        const res = await fetch(
          `/api/issues/pull-requests?owner=${owner}&repo=${repo}&numbers=${numbersKey}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data: IssuePullRequestListResponse = await res.json();
        if (cancelled) return;
        const selected = selectIssuePullRequests(data.pullRequests, targetIssueNumber);
        setPullRequests(selected);
        if (intervalId && !selected.some(isIssuePullRequestSettling)) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }

    load(false);
    if (pollWhileCiRunning) {
      intervalId = setInterval(() => load(true), POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (intervalId) clearInterval(intervalId);
    };
  }, [owner, repo, issueNumber, numbersKey, pollWhileCiRunning, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  return { pullRequests, refresh };
}
