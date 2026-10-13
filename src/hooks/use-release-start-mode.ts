"use client";

import { useEffect, useState } from "react";

import { fetchReleaseStartModes } from "@/lib/release-request";
import type { ReleaseStartMode } from "@/lib/release-start-mode";

/**
 * リポジトリのリリース開始方式（#4604）。`enabled`の間だけ1回取る。取得中は`null`
 * （呼び出し側は操作を無効にし、取得後に方式に合った確認表示を出す）
 */
export function useReleaseStartMode(repositoryFullName: string, enabled: boolean): ReleaseStartMode | null {
  const [loaded, setLoaded] = useState<{ repo: string; mode: ReleaseStartMode } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchReleaseStartModes([repositoryFullName]).then((modes) => {
      if (!cancelled) setLoaded({ repo: repositoryFullName, mode: modes[repositoryFullName] });
    });
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, enabled]);
  return loaded && loaded.repo === repositoryFullName ? loaded.mode : null;
}
