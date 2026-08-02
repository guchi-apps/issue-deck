"use client";

import { useEffect, useState } from "react";

export type ReleasePullRequest = {
  number: number;
  url: string;
  title: string;
};

export type ReleaseStatus =
  | { available: false }
  | {
      available: true;
      mainVersion: string | null;
      developVersion: string | null;
      bumpPullRequest: ReleasePullRequest | null;
      releasePullRequest: ReleasePullRequest | null;
    };

function errorMessageForResponse(status: number, errorCode: string | undefined): string {
  if (errorCode === "github_reauth_required") {
    return "GitHub連携が必要です。再ログインしてください。";
  }
  return `リクエストに失敗しました (${status})`;
}

export function useReleaseStatus(repoFullName: string | null, enabled: boolean) {
  const [data, setData] = useState<ReleaseStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  useEffect(() => {
    if (!enabled || !repoFullName) return;

    const [owner, repo] = repoFullName.split("/");
    let cancelled = false;
    // ドロップダウンを開いたタイミングで一度だけ外部システム（GitHub API）から取得する同期処理であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setData(null);
    setError(null);

    fetch(`/api/repositories/release?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errorMessageForResponse(res.status, json.error));
        return json as ReleaseStatus;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, repoFullName]);

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
      if (!res.ok) throw new Error(errorMessageForResponse(res.status, json.error));
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
