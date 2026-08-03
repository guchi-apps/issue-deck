"use client";

import { useEffect, useState } from "react";

import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import type { PullRequestLink } from "@/lib/github/pull-request-link";

const POLL_INTERVAL_MS = 20_000;

type UsePullRequestCiStatusResult = {
  status: PullRequestCiStatus | null;
};

/** enabled中のみ、対応PRの最新コミットのCI状態をポーリングする（in_progressでなくなったら停止） */
export function usePullRequestCiStatus(
  repositoryFullName: string | null,
  pullRequestLink: PullRequestLink | null,
  enabled: boolean,
): UsePullRequestCiStatusResult {
  const [status, setStatus] = useState<PullRequestCiStatus | null>(null);

  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];
  const number = pullRequestLink?.number ?? null;

  useEffect(() => {
    if (!enabled || !owner || !repo || !number) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus(null);
      return;
    }

    let cancelled = false;
    let isCompleted = false;
    const controller = new AbortController();

    async function fetchStatus() {
      if (document.hidden || isCompleted) return;
      try {
        const res = await fetch(
          `/api/issues/pull-request-ci-status?owner=${owner}&repo=${repo}&number=${number}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data: { status: PullRequestCiStatus } = await res.json();
        if (cancelled) return;
        setStatus(data.status);
        isCompleted = data.status !== "in_progress";
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }

    fetchStatus();
    const intervalId = setInterval(fetchStatus, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, [enabled, owner, repo, number]);

  return { status };
}
