"use client";

import { useCallback, useEffect, useState } from "react";

import type { IosRunVerdict, IosStageStatus } from "@/lib/ios-testflight-status";

export type IosTestflightRun = {
  id: number;
  htmlUrl: string;
  headSha: string;
  headBranch: string | null;
  event: string;
  createdAt: string;
  status: string;
  conclusion: string | null;
  verdict: IosRunVerdict;
  stages: IosStageStatus[];
  notes: string[];
};

export type IosTestflightResponse =
  | { available: false }
  | {
      available: true;
      latestDeliveredBuild: { tag: string; buildNumber: number } | null;
      runs: IosTestflightRun[];
      /** `prNumber`を渡したときだけ入る、その版（リリースPR）の配布状態（#3644） */
      release?: {
        sha: string | null;
        merged: boolean;
        isMainTip: boolean;
        webDeploy: "success" | "pending" | "failed";
        deliveredBuild: number | null;
      };
    };

/**
 * リリース画面のiOS（TestFlight）配布結果の取得（#3626）。
 *
 * 画面を開いたときと更新ボタンを押したときに取る。実行中のrunがあるあいだだけ30秒間隔で
 * 取り直す（配布の処理待ちは数分〜十数分かかるため）。それ以外はポーリングしない。
 */
export function useIosTestflight(owner: string, repo: string, enabled: boolean, prNumber?: number) {
  const [data, setData] = useState<IosTestflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  const hasRunning = data?.available === true && data.runs.some((run) => run.status !== "completed");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    const pr = prNumber === undefined ? "" : `&pr=${prNumber}`;
    fetch(`/api/repositories/ios-testflight?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${pr}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as IosTestflightResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : "取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [owner, repo, enabled, prNumber, reloadKey]);

  useEffect(() => {
    if (!enabled || !hasRunning) return;
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, hasRunning, refresh]);

  return { data, error, isLoading, refresh };
}
