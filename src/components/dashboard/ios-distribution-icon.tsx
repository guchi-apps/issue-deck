"use client";

import { Loader2, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { useIosTestflight } from "@/hooks/use-ios-testflight";
import {
  isIosDistributionPending,
  isIosDistributionRunning,
  judgeIosReleasePanel,
} from "@/lib/ios-testflight-status";

const PENDING_REFRESH_MS = 60_000;

/**
 * 畳んだ行のiOS配布の状態（#3759・#3799・#3806）。最新のマージ済みリリース（`prNumber`）が
 * TestFlightへ配布できていないか（`pending`）、配布のworkflowが走っているか（`running`）を返す。
 * アイコンとバッジが同じ1回の取得を共有できるよう、取得は行コンポーネントのここで1回だけ行う。
 * 取得は画面表示時に1回で、未配布の間だけ60秒おきに取り直す。`enabled`がfalseなら取得しない。
 */
export function useIosDistributionState(
  owner: string,
  repo: string,
  prNumber: number | null,
  enabled: boolean,
): { pending: boolean; running: boolean } {
  // 未配布の間だけ長めの間隔で取り直す（束の「配布する」で配布が済んだら斜線が消える）。
  // 裏のタブでは`useIosTestflight`が取りに行かない
  const [watching, setWatching] = useState(false);
  const { data } = useIosTestflight(owner, repo, enabled && prNumber !== null, prNumber ?? undefined, {
    pollIntervalMs: PENDING_REFRESH_MS,
    pollWhileActive: watching,
  });
  const release = data?.available ? data.release : undefined;
  const state =
    data?.available === true && release !== undefined && release.merged && release.sha !== null
      ? judgeIosReleasePanel({
          webDeploy: release.webDeploy,
          isMainTip: release.isMainTip,
          deliveredBuild: release.deliveredBuild,
          runs: data.runs,
          sha: release.sha,
        })
      : null;
  const pending = isIosDistributionPending(state);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWatching(pending);
  }, [pending]);
  return { pending, running: isIosDistributionRunning(state) };
}

/**
 * 畳んだ行のiOS自動配布アイコン（#3759・#3799）。未配布の間だけ、スマホに斜線を重ねる。
 * 色・大きさは配布済みと同じで、文字は足さない（足すとスマホ幅で行が折り返す。#2172）。
 */
export function IosDistributionIcon({ pending }: { pending: boolean }) {
  const label = pending ? "iOS未配布" : "iOS自動配布";

  return (
    <span title={label} aria-label={label} className="relative inline-flex shrink-0 text-blue-600 dark:text-blue-400">
      <Smartphone className="size-3.5" aria-hidden="true" />
      {pending && (
        <svg viewBox="0 0 14 14" className="absolute inset-0 size-3.5" aria-hidden="true">
          <line x1="1.5" y1="1.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

/**
 * TestFlightへの配布が実行中の間だけ出すピル（#3806）。「デプロイ中」と同じ形で、色は配布カードと同じ青
 * （紫＝リリース・デプロイと重ねない）。畳んだ行は`<button>`なのでリンクにはしない。
 */
export function IosDistributingBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 ring-1 ring-inset ring-blue-500 dark:text-blue-300"
      aria-label="iOS配布中（TestFlightへ配布しています）"
    >
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      iOS配布中
    </span>
  );
}
