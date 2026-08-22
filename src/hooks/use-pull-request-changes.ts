"use client";

import { useEffect, useState } from "react";

import { parsePullRequestId } from "@/lib/github-reference";
import type { PullRequestChange, PullRequestChangeListResponse } from "@/types/pull-request";

type UsePullRequestChangesResult = {
  changes: PullRequestChange[] | null;
  /** 取得できたコミット数（打ち切っている場合は上限値） */
  commitCount: number;
  /** 1ページの上限で打ち切ったか */
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
};

/**
 * マージ確認ダイアログに出す「このマージに含まれる変更」を取得する（#2080）。
 *
 * **`enabled`（＝mainへのPRの確認ダイアログを開いているか）がtrueのときだけ取りに行く。**
 * 通常のPRのマージや、ダイアログを開かない1クリックのマージではGitHub APIを消費しない、
 * というのがこの表示の前提になっている（`use-pull-request-files.ts`と同じ考え方）。
 *
 * **開き直すと取り直す。** 確認ダイアログの中身は閉じるとアンマウントされる（Radixの既定）ので
 * この状態も消えるが、それでよい——developは開いているあいだも動くため、確認のたびに最新を
 * 見せる方が正しく、同じ内容ならETagの304になりレート制限を消費しない
 * （`fetchPullRequestCommits`）。失敗した場合も同じで、開き直せばやり直しになる。
 * ダイアログの中に「再試行」を置くと、マージの確認より目立つ操作が増えてしまう。
 */
export function usePullRequestChanges(
  /** PRのid（`<owner>/<repo>#<番号>`）。未選択ならnull */
  pullRequestId: string | null,
  enabled: boolean,
): UsePullRequestChangesResult {
  const [loaded, setLoaded] = useState<{
    key: string;
    changes: PullRequestChange[];
    commitCount: number;
    truncated: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const key = pullRequestId;
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
        const res = await fetch(`/api/pull-requests/changes?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
          throw new Error(
            data.error === "github_api_error" && data.message
              ? data.message
              : `変更点を取得できませんでした (${res.status})`,
          );
        }
        const data: PullRequestChangeListResponse = await res.json();
        if (cancelled) return;
        setLoaded({
          key,
          changes: data.changes,
          commitCount: data.commitCount,
          truncated: data.truncated,
        });
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
    changes: current?.changes ?? null,
    commitCount: current?.commitCount ?? 0,
    truncated: current?.truncated ?? false,
    isLoading: loadingKey !== null && loadingKey === key,
    error,
  };
}
