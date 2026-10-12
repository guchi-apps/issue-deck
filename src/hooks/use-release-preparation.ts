"use client";

import { useCallback, useEffect, useState } from "react";

import type { ReleasePreparationFailureView } from "@/lib/release-preparation";
import { resolveReleasePrepState, type ReleasePrepState } from "@/lib/release-prep-state";

export type ReleasePreparationFailureWithAction = ReleasePreparationFailureView & { nextAction: string };

export type ReleasePreparation = {
  failure: ReleasePreparationFailureWithAction | null;
  /** 準備が進行中の修正系列の状態（#4421）。失敗の帯とボタンの無効化が同じ取得を共有する */
  prepState: ReleasePrepState;
  reload: () => Promise<void>;
};

/**
 * リリース準備の記録（`GET /api/repositories/release/preparation`。DBのみ）を60秒おきに取り直す。
 * 取れなければ前回の値を残す（取得失敗を「失敗なし」や「準備中」の根拠にしない）。
 */
export function useReleasePreparation(repositoryFullName: string, enabled = true): ReleasePreparation {
  const [owner, repo] = repositoryFullName.split("/");
  const [failure, setFailure] = useState<ReleasePreparationFailureWithAction | null>(null);
  const [prepState, setPrepState] = useState<ReleasePrepState>("idle");

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/repositories/release/preparation?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const nextFailure = data?.failure ?? null;
      setFailure(nextFailure);
      setPrepState(
        resolveReleasePrepState({
          hasOpenFailure: nextFailure !== null,
          activeFixSeriesStatuses: Array.isArray(data?.activeFixSeriesStatuses) ? data.activeFixSeriesStatuses : [],
        }),
      );
    } catch {
      // 取れなければ前回の表示のまま
    }
  }, [owner, repo]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得結果の反映（同期的なsetStateではない）
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [enabled, reload]);

  return { failure, prepState, reload };
}
