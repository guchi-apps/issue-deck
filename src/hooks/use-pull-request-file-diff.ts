"use client";

import { useCallback, useEffect, useState } from "react";

import { parsePullRequestId } from "@/lib/github-reference";
import type { PullRequestFileDiffResponse } from "@/types/pull-request";

type UsePullRequestFileDiffResult = {
  /** 差分本文。GitHubが省略した場合はnull、未取得はundefined */
  patch: string | null | undefined;
  isLoading: boolean;
  error: string | null;
  /** 失敗したときのやり直し */
  retry: () => void;
};

/**
 * 変更ファイル一覧の1行にある「差分を表示」を押したときに、そのファイルの差分を取得する
 * （#3383）。
 *
 * `usePullRequestFiles`（一覧本体の遅延取得）と同じ形——**`enabled`（＝その行を開いているか）が
 * trueのときだけ取りに行き、一度取れたら閉じても捨てない。** ファイルごとにコンポーネントの
 * インスタンスが分かれるため、PRを切り替えればコンポーネントごと消え、取得結果を持ち越す心配は
 * ない。
 */
export function usePullRequestFileDiff(
  /** PRのid（`<owner>/<repo>#<番号>`）。未選択ならnull */
  pullRequestId: string | null,
  path: string,
  enabled: boolean,
): UsePullRequestFileDiffResult {
  const [loaded, setLoaded] = useState<{ key: string; patch: string | null } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((prev) => prev + 1), []);

  const key = pullRequestId === null ? null : `${pullRequestId}\t${path}\t${retryCount}`;
  const current = loaded !== null && loaded.key === key ? loaded : null;
  const error = failure !== null && failure.key === key ? failure.message : null;

  useEffect(() => {
    const parsed = pullRequestId ? parsePullRequestId(pullRequestId) : null;
    // 取得済み・取得に失敗した直後のキーで再び走らせない（開閉のたびにAPIを消費しない）
    if (!parsed || !enabled || key === null || current !== null || error !== null) return;

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (!parsed || key === null) return;
      setLoadingKey(key);
      try {
        const [owner, repo] = parsed.repositoryFullName.split("/");
        const params = new URLSearchParams({
          owner,
          repo,
          number: String(parsed.number),
          path,
        });
        const res = await fetch(`/api/pull-requests/file-diff?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `差分を取得できませんでした (${res.status})`,
          );
        }
        const data: PullRequestFileDiffResponse = await res.json();
        if (cancelled) return;
        setLoaded({ key, patch: data.patch });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled) return;
        setFailure({ key, message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!cancelled) setLoadingKey(null);
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pullRequestId, path, enabled, key, current, error]);

  return {
    patch: current?.patch,
    isLoading: loadingKey !== null && loadingKey === key,
    error,
    retry,
  };
}
