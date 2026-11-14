"use client";

import { useCallback, useEffect, useState } from "react";

import { clientErrorMessage } from "@/lib/client-error-message";
import type { GithubApiUsageSummary } from "@/lib/github/api-usage";

/** `GET /api/github/api-usage`の`rateLimits`の1要素（インストールごとのGitHub実消費）。 */
export type GithubRestRateLimit =
  | {
      accountLogin: string;
      used: number;
      limit: number;
      remaining: number;
      /** 窓のリセット時刻(epoch秒) */
      reset: number;
      windowStartedAt: number;
      measuredInWindow: number;
      unmeasuredInWindow: number;
      error?: undefined;
    }
  | { accountLogin: string; error: "core_missing" | "fetch_failed" };

export type GithubRestUsage = GithubApiUsageSummary & { rateLimits: GithubRestRateLimit[] };

/**
 * AI使用量ページのGitHub REST枠用。ページ（ペイン）を開いたときの1回と、更新ボタン（`refresh`）でだけ
 * 取得する（インストール数ぶんGitHubへ問い合わせるため）。パネルは使用量ペインが開いている間だけ
 * マウントされるので、非表示のときは呼ばない。
 */
export function useGithubRestUsage() {
  const [data, setData] = useState<GithubRestUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/github/api-usage", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as GithubRestUsage;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(clientErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, error, isLoading: data === null && error === null, refresh };
}
