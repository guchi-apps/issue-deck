"use client";

import { useCallback, useEffect, useState } from "react";

import type { DevelopSyncStatus } from "@/lib/release-develop-sync";
import type { RcFinalizationOverview } from "@/lib/release-finalize-run";
import type { RcOverview } from "@/lib/release-rc-run";

/**
 * 候補の状況に、公開準備（#4496）の状況と、本番反映以降のdevelop同期（#4641）の状況を足したもの。
 * どちらも無い応答（旧い応答）でも読める
 */
export type RcOverviewWithFinalization = RcOverview & { finalization?: RcFinalizationOverview | null; developSync?: DevelopSyncStatus | null };

const ACTIVE_POLL_MS = 10_000;
const RETRY_POLL_MS = 30_000;

/** 作成・更新・検証が動いている状態。この間だけ短い間隔で取り直す */
const ACTIVE_STATUSES = new Set([
  "creating",
  "fixing",
  "awaiting_verification",
  "verifying",
  "preparing",
  "awaiting_approval",
  "deploying",
  "verifying_production",
]);

/**
 * リリース候補（#4495）の状況。本番PR詳細から、そのPRに対応する候補（過去のものも含む）と、
 * 旧方式の候補・callerの対応状況を読む。**取得に失敗しても止めず、間隔を空けて取り直す。**
 * 失敗は`error`に残し、「候補なし」とは区別する
 */
export function useReleaseRc(
  repositoryFullName: string,
  pullRequestNumber: number,
  enabled: boolean,
  reloadToken = 0,
): { overview: RcOverviewWithFinalization | null; error: string | null; reload: () => void } {
  const key = `${repositoryFullName}#${pullRequestNumber}`;
  const [loaded, setLoaded] = useState<{ key: string; overview: RcOverviewWithFinalization } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [localReload, setLocalReload] = useState(0);
  const reload = useCallback(() => setLocalReload((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [owner, repo] = repositoryFullName.split("/");
    const params = new URLSearchParams({ owner, repo, pullRequest: String(pullRequestNumber) });

    const load = async () => {
      let delay: number | null = null;
      try {
        const res = await fetch(`/api/repositories/release/rc?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`リリース候補の状況を取得できませんでした (${res.status})`);
        const body: RcOverviewWithFinalization = await res.json();
        setLoaded({ key, overview: body });
        setFailure(null);
        if (body.candidate && ACTIVE_STATUSES.has(body.candidate.status.status)) delay = ACTIVE_POLL_MS;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFailure({ key, message: err instanceof Error ? err.message : String(err) });
        delay = RETRY_POLL_MS;
      }
      if (delay !== null && !controller.signal.aborted) timer = setTimeout(load, delay);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, repositoryFullName, pullRequestNumber, reloadToken, localReload]);

  return {
    overview: loaded?.key === key ? loaded.overview : null,
    error: failure?.key === key ? failure.message : null,
    reload,
  };
}
