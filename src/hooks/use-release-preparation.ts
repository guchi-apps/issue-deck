"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 * 未取得（初回・リポジトリ切替・取得失敗）の間は`prepState`を`unknown`とし、idleと同一視しない（#4556）。
 */
export function useReleasePreparation(repositoryFullName: string, enabled = true): ReleasePreparation {
  const [owner, repo] = repositoryFullName.split("/");
  // 取得結果は取得元のリポジトリと一緒に持つ。別リポジトリの値や未取得をidleとして使わない（#4556）
  const [loaded, setLoaded] = useState<{
    repositoryFullName: string;
    failure: ReleasePreparationFailureWithAction | null;
    prepState: ReleasePrepState;
  } | null>(null);
  const currentRepository = useRef(repositoryFullName);
  useEffect(() => {
    currentRepository.current = repositoryFullName;
  }, [repositoryFullName]);

  const reload = useCallback(async () => {
    const requestedFor = repositoryFullName;
    try {
      const res = await fetch(`/api/repositories/release/preparation?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data) return;
      // 遅れて届いた別リポジトリの応答は捨てる
      if (currentRepository.current !== requestedFor) return;
      const nextFailure = data.failure ?? null;
      setLoaded({
        repositoryFullName: requestedFor,
        failure: nextFailure,
        prepState: resolveReleasePrepState({
          hasOpenFailure: nextFailure !== null,
          activeFixSeriesStatuses: Array.isArray(data.activeFixSeriesStatuses) ? data.activeFixSeriesStatuses : [],
        }),
      });
    } catch {
      // 取れなければ前回の表示のまま（未取得なら未取得のまま＝起動できない）
    }
  }, [owner, repo, repositoryFullName]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得結果の反映（同期的なsetStateではない）
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [enabled, reload]);

  const current = loaded?.repositoryFullName === repositoryFullName ? loaded : null;
  return { failure: current?.failure ?? null, prepState: current?.prepState ?? "unknown", reload };
}
