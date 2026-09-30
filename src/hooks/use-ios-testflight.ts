"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { IosRunVerdict, IosStageStatus } from "@/lib/ios-testflight-status";

export type IosTestflightRun = {
  id: number;
  htmlUrl: string;
  headSha: string;
  headBranch: string | null;
  event: string;
  createdAt: string;
  updatedAt: string;
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

export type UseIosTestflightOptions = {
  /** 取り直す間隔。省略時は従来どおり30秒（実行中のrunがあるときだけ） */
  pollIntervalMs?: number;
  /** trueの間は、実行中のrunが無くても`pollIntervalMs`で取り直す（内訳を開いている間、#3665）。省略時はfalse */
  pollWhileActive?: boolean;
  /** trueの間は取り直さない（過去の版の束など、いま追う必要が無い欄用） */
  pollPaused?: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * リリース画面のiOS（TestFlight）配布結果の取得（#3626）。
 *
 * 画面を開いたときと更新ボタンを押したときに取る。実行中のrunがある間（と、呼び出し側が
 * `pollWhileActive`で指定した間）だけ取り直す。**取り直し（ポーリング）では`isLoading`を立てず**、
 * 更新アイコンを回さない。裏に回っているタブでは取りに行かず、前面へ戻ったら取り直す（#3665）。
 */
export function useIosTestflight(
  owner: string,
  repo: string,
  enabled: boolean,
  prNumber?: number,
  options: UseIosTestflightOptions = {},
) {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, pollWhileActive = false, pollPaused = false } = options;
  const [data, setData] = useState<IosTestflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  // 取得関数は取得effectの中で作ってrefへ預け、ポーリングがeffectを再実行させずに呼べるようにする
  const silentLoadRef = useRef<(() => Promise<void>) | null>(null);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  const hasRunning = data?.available === true && data.runs.some((run) => run.status !== "completed");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    let inFlight = false;
    const pr = prNumber === undefined ? "" : `&pr=${prNumber}`;
    const url = `/api/repositories/ios-testflight?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${pr}`;

    async function load(silent: boolean) {
      if (inFlight) return;
      inFlight = true;
      if (!silent) setIsLoading(true);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const json = (await res.json()) as IosTestflightResponse;
        if (cancelled) return;
        setData(json);
        setError(null);
        setLastFetchedAt(Date.now());
      } catch (e: unknown) {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : "取得に失敗しました");
      } finally {
        inFlight = false;
        if (!cancelled && !silent) setIsLoading(false);
      }
    }

    silentLoadRef.current = () => load(true);
    void load(false);
    return () => {
      cancelled = true;
      controller.abort();
      silentLoadRef.current = null;
    };
  }, [owner, repo, enabled, prNumber, reloadKey]);

  const shouldPoll = enabled && !pollPaused && (hasRunning || pollWhileActive);
  useEffect(() => {
    if (!shouldPoll) return;
    function poll() {
      if (document.hidden) return;
      void silentLoadRef.current?.();
    }
    const timer = window.setInterval(poll, pollIntervalMs);
    function onVisible() {
      if (!document.hidden) poll();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shouldPoll, pollIntervalMs]);

  return { data, error, isLoading, refresh, lastFetchedAt };
}
