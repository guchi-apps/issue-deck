"use client";

import { useEffect, useMemo, useState } from "react";

import { extractLatestPullRequestLink, type PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssueComment } from "@/types/issue";

/**
 * まずコメント本文からのURLパース（追加通信なし）で対応PRを探し、見つからない場合のみ
 * Issue Timeline APIのcross-referenceフォールバック（`/api/issues/pull-request-link`）へ問い合わせる。
 */
export function usePullRequestLink(
  repositoryFullName: string | null,
  issueNumber: number | null,
  comments: IssueComment[],
): PullRequestLink | null {
  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];

  const commentLink = useMemo(
    () => (owner && repo ? extractLatestPullRequestLink(comments, owner, repo) : null),
    [comments, owner, repo],
  );
  const [fallbackLink, setFallbackLink] = useState<PullRequestLink | null>(null);

  useEffect(() => {
    if (commentLink || !owner || !repo || !issueNumber) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallbackLink(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    fetch(`/api/issues/pull-request-link?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { link: PullRequestLink | null } | null) => {
        if (cancelled || !data) return;
        setFallbackLink(data.link);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [commentLink, owner, repo, issueNumber]);

  return commentLink ?? fallbackLink;
}
