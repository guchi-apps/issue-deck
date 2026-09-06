"use client";

import { useEffect, useState } from "react";

import { isCodeReviewIssue, type CodeReviewSummary } from "@/lib/github/code-review";
import type { Issue } from "@/types/issue";

/**
 * 一覧に並ぶレビューIssue（#698）の結果を、行のバッジ用にまとめて取る（#2855）。
 *
 * **取りに行くのは「コードレビュー」ビューを開いている間だけで、ポーリングもしない。**
 * 結果はIssueコメントにしか無く、行に出すためだけに他のビューでも引くと、並んでいるIssueの
 * 数だけGitHubを叩くことになる。走っているレビューの結果は一覧の自動更新でコメント件数が
 * 変わった時点（＝`issues`の中身が変わった時点）に取り直される。
 *
 * 取れなかったIssueは戻り値に入らない。行のバッジが出ないだけで、一覧そのものは今までどおり出す。
 */
export function useCodeReviewReports(
  issues: Issue[],
  enabled: boolean,
): ReadonlyMap<string, CodeReviewSummary> {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, CodeReviewSummary>>(new Map());

  const targets = enabled ? issues.filter(isCodeReviewIssue) : [];
  // コメント件数まで含めてキーにする。レビュー結果が返るとコメントが1件増えるので、
  // 一覧の自動更新がそれを拾った時点で取り直しになる
  const targetKey = targets
    .map((issue) => `${issue.repositoryFullName}#${issue.number}:${issue.commentCount}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (targetKey === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummaries(new Map());
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      const keys = targetKey.split(",").map((entry) => entry.split(":")[0]);
      try {
        const params = new URLSearchParams({ issues: keys.join(",") });
        const res = await fetch(`/api/issues/code-review-reports?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data: { summaries?: ({ key: string } & CodeReviewSummary)[] } = await res.json();
        if (cancelled) return;
        setSummaries(
          new Map((data.summaries ?? []).map(({ key, ...summary }) => [key, summary])),
        );
      } catch {
        // 取れなければバッジを出さないだけ。一覧の表示は止めない
      }
    }

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [targetKey]);

  return summaries;
}

/** 一覧の行から要約を引くためのキー。APIへ渡す形（`owner/repo#123`）と同じ */
export function codeReviewSummaryKey(issue: Pick<Issue, "repositoryFullName" | "number">): string {
  return `${issue.repositoryFullName}#${issue.number}`;
}
