"use client";

import { Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { useIosTestflight } from "@/hooks/use-ios-testflight";
import { isIosDistributionPending, judgeIosReleasePanel } from "@/lib/ios-testflight-status";

const PENDING_REFRESH_MS = 60_000;

/**
 * 畳んだ行のiOS自動配布アイコン（#3759・#3799）。最新のマージ済みリリース（`prNumber`）が
 * TestFlightへ配布できていない間だけ、スマホに斜線を重ねる。色・大きさは配布済みと同じで、文字は足さない
 * （足すとスマホ幅で行が折り返す。#2172）。取得は画面表示時に1回で、未配布の間だけ60秒おきに取り直す。
 */
export function IosDistributionIcon({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number | null;
}) {
  // 未配布の間だけ長めの間隔で取り直す（束の「配布する」で配布が済んだら斜線が消える）。
  // 裏のタブでは`useIosTestflight`が取りに行かない
  const [watching, setWatching] = useState(false);
  const { data } = useIosTestflight(owner, repo, prNumber !== null, prNumber ?? undefined, {
    pollIntervalMs: PENDING_REFRESH_MS,
    pollWhileActive: watching,
  });
  const release = data?.available ? data.release : undefined;
  const pending =
    data?.available === true &&
    release !== undefined &&
    release.merged &&
    release.sha !== null &&
    isIosDistributionPending(
      judgeIosReleasePanel({
        webDeploy: release.webDeploy,
        isMainTip: release.isMainTip,
        deliveredBuild: release.deliveredBuild,
        runs: data.runs,
        sha: release.sha,
      }),
    );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWatching(pending);
  }, [pending]);
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
