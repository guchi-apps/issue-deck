"use client";

import { useEffect, useState } from "react";

import type { ReleaseChangeListResponse } from "@/types/pull-request";

export type UseReleaseChangesResult = {
  data: ReleaseChangeListResponse | null;
  isLoading: boolean;
  error: string | null;
};

/**
 * リリース起動確認の「今回反映する内容」（PR単位）を取得する（#4201）。
 *
 * `enabled`（確認ダイアログを開いているか）がtrueのときだけ取りに行き、開くたびに取り直す
 * （developは動き続けるため、確認のたびに最新を見せる）。失敗は`error`に残し、
 * 空の一覧にはしない。`pullRequestNumber`を渡すと作成済みリリースPRの固定範囲を取る。
 */
export function useReleaseChanges(
  repositoryFullName: string,
  enabled: boolean,
  pullRequestNumber: number | null = null,
): UseReleaseChangesResult {
  const key = `${repositoryFullName}#${pullRequestNumber ?? "develop"}`;
  const [loaded, setLoaded] = useState<{ key: string; data: ReleaseChangeListResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const [owner, repo] = repositoryFullName.split("/");
    const params = new URLSearchParams({ owner, repo });
    if (pullRequestNumber !== null) params.set("pullRequest", String(pullRequestNumber));

    void (async () => {
      try {
        const res = await fetch(`/api/repositories/release/changes?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            body.error === "github_api_error" && body.message
              ? body.message
              : `反映内容を取得できませんでした (${res.status})`,
          );
        }
        const data: ReleaseChangeListResponse = await res.json();
        // 想定外の応答を空の一覧として扱わない
        if (!Array.isArray(data.pullRequests) || !Array.isArray(data.unknownCommits)) {
          throw new Error("反映内容の応答が不正です");
        }
        setLoaded({ key, data });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFailure({ key, message: err instanceof Error ? err.message : String(err) });
      }
    })();

    // 閉じたら結果を捨てる。開き直したときに前回の一覧が一瞬見えないようにする
    return () => {
      controller.abort();
      setLoaded(null);
      setFailure(null);
    };
  }, [enabled, repositoryFullName, pullRequestNumber, key]);

  const data = loaded !== null && loaded.key === key ? loaded.data : null;
  const error = failure !== null && failure.key === key ? failure.message : null;
  return { data, isLoading: enabled && data === null && error === null, error };
}
