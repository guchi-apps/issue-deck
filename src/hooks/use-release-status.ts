"use client";

import { useEffect, useState } from "react";

export type ReleasePullRequest = {
  number: number;
  url: string;
  title: string;
};

/** CIの集約状態。`unknown`は権限不足やチェック未検出で判定できないことを表す */
export type CiState = "pending" | "success" | "failure" | "unknown";

export type BumpPullRequest = ReleasePullRequest & {
  ciState: CiState | null;
};

export type ReleaseWorkflowRun = {
  /** queued | in_progress | completed など */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
};

/** リリース進行の論理段階。詳細はAPI(route.ts)側のコメントを参照 */
export type ReleasePhase = "none" | "bump_pr_open" | "release_pending" | "release_pr_open";

export type ReleaseStatus =
  | { available: false }
  | {
      available: true;
      mainVersion: string | null;
      developVersion: string | null;
      phase: ReleasePhase;
      workflowRun: ReleaseWorkflowRun | null;
      bumpPullRequest: BumpPullRequest | null;
      releasePullRequest: ReleasePullRequest | null;
    };

function errorMessageForResponse(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/** シートを開いている間、進捗をライブ更新するためのポーリング間隔（ミリ秒） */
const POLL_INTERVAL_MS = 6000;

export function useReleaseStatus(repoFullName: string | null, enabled: boolean) {
  const [data, setData] = useState<ReleaseStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  // triggerRelease成功時などに即時再取得させるためのキー。増やすと下のeffectが再実行される。
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled || !repoFullName) return;

    const [owner, repo] = repoFullName.split("/");
    let cancelled = false;

    // initial=true の初回のみローディング表示・data初期化を行う。以降のポーリング更新では
    // 画面をちらつかせないよう、取得済みdataを保ったまま差し替える。
    async function load(initial: boolean) {
      if (initial) {
        setIsLoading(true);
        setData(null);
        setError(null);
      }
      try {
        const res = await fetch(
          `/api/repositories/release?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errorMessageForResponse(res.status, json.error, json.message));
        if (!cancelled) {
          setData(json as ReleaseStatus);
          setError(null);
        }
      } catch (err) {
        // ポーリング中の一時的な失敗で既存の表示を消さないよう、初回のみエラーを表面化する。
        if (!cancelled && initial) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && initial) setIsLoading(false);
      }
    }

    // 開いた瞬間に外部システム（GitHub API）から取得し、以降は一定間隔でライブ更新する。
    load(true);
    const timer = setInterval(() => load(false), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, repoFullName, reloadKey]);

  async function triggerRelease(): Promise<boolean> {
    if (!repoFullName) return false;
    const [owner, repo] = repoFullName.split("/");

    setIsTriggering(true);
    setError(null);
    try {
      const res = await fetch("/api/repositories/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorMessageForResponse(res.status, json.error, json.message));
      // 起動直後に状態を取り直して、実行中runやバンプPRの出現を素早く反映する。
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsTriggering(false);
    }
  }

  return { data, isLoading, error, triggerRelease, isTriggering };
}
