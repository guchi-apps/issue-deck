"use client";

import { useCallback, useEffect, useState } from "react";

import { parsePullRequestId } from "@/lib/github-reference";
import type { PullRequestFile, PullRequestFileListResponse } from "@/types/pull-request";

type UsePullRequestFilesResult = {
  files: PullRequestFile[] | null;
  /** 1ページの上限で打ち切ったか（#1987） */
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
  /** 失敗したときのやり直し */
  retry: () => void;
};

/**
 * 選択中PRの変更ファイル一覧を取得する（#1987）。
 *
 * **`enabled`（＝画面で「変更ファイル」を開いているか）がtrueのときだけ取りに行く。**
 * 畳んでいる間はGitHub APIを消費しない、というのがこの折りたたみの前提なので、
 * ここで取得を止めるのが仕組み上の要になる。
 *
 * 一度取れたら畳んでも捨てない（同じPRを開き直したときに待たせない）。PRを切り替えたときと、
 * 詳細ヘッダーの「更新」を押したとき（`refreshKey`の変化）だけ取り直す。取得結果・エラーは
 * どの取得に対するものかを表すキーと一緒に持ち、**キーが違えば無かったものとして扱う**
 * ——切り替えた直後に前のPRのファイル一覧やエラーが残らないようにするため。
 */
export function usePullRequestFiles(
  /** PRのid（`<owner>/<repo>#<番号>`）。未選択ならnull */
  pullRequestId: string | null,
  enabled: boolean,
  /** 詳細の取得時刻。ヘッダーの「更新」でこちらも取り直すためのキー */
  refreshKey?: string | null,
): UsePullRequestFilesResult {
  const [loaded, setLoaded] = useState<{
    key: string;
    files: PullRequestFile[];
    truncated: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((prev) => prev + 1), []);

  const key =
    pullRequestId === null ? null : `${pullRequestId}\t${refreshKey ?? ""}\t${retryCount}`;
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
        const params = new URLSearchParams({ owner, repo, number: String(parsed.number) });
        const res = await fetch(`/api/pull-requests/files?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `変更ファイルを取得できませんでした (${res.status})`,
          );
        }
        const data: PullRequestFileListResponse = await res.json();
        if (cancelled) return;
        setLoaded({ key, files: data.files, truncated: data.truncated });
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
  }, [pullRequestId, enabled, key, current, error]);

  return {
    files: current?.files ?? null,
    truncated: current?.truncated ?? false,
    isLoading: loadingKey !== null && loadingKey === key,
    error,
    retry,
  };
}
