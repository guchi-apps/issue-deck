"use client";

import { useEffect, useMemo, useState } from "react";

import { extractPullRequestLinks, type PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssueComment } from "@/types/issue";

const EMPTY_LINKS: PullRequestLink[] = [];

/**
 * Issueの対応PRのリンクを返す（#1339で複数対応）。
 *
 * まずコメント本文からのURLパース（追加通信なし）で対応PRを探し、**1件も見つからない場合のみ**
 * Issue Timeline APIのcross-referenceフォールバック（`/api/issues/pull-request-link`）へ
 * 問い合わせる。コメントで1件でも見つかればフォールバックしないのは、GitHub APIの消費を
 * 増やさないため（コメントに書かれていないPRを取りこぼす可能性は残るが、無人実行は
 * PRごとに報告コメントを投稿するので実運用では揃う）。
 */
export function usePullRequestLinks(
  repositoryFullName: string | null,
  issueNumber: number | null,
  comments: IssueComment[],
): PullRequestLink[] {
  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];

  const commentLinks = useMemo(
    () => (owner && repo ? extractPullRequestLinks(comments, owner, repo) : EMPTY_LINKS),
    [comments, owner, repo],
  );
  const [fallbackLinks, setFallbackLinks] = useState<PullRequestLink[]>(EMPTY_LINKS);

  useEffect(() => {
    if (commentLinks.length > 0 || !owner || !repo || !issueNumber) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallbackLinks(EMPTY_LINKS);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    fetch(`/api/issues/pull-request-link?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { links: PullRequestLink[] } | null) => {
        if (cancelled || !data) return;
        setFallbackLinks(data.links);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [commentLinks, owner, repo, issueNumber]);

  return commentLinks.length > 0 ? commentLinks : fallbackLinks;
}
