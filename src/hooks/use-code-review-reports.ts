"use client";

import { useEffect, useState } from "react";

import { isCodeReviewIssue, type CodeReviewSummary } from "@/lib/github/code-review";

/**
 * 順番待ち・実行中のレビューがある間だけ取り直す間隔（#4116）。結果はコメント件数の変化で
 * 取り直されるが、失敗・時間切れはコメントを増やさないため、これが無いと「レビュー中」から動かない。
 * 取り直しはDBのジョブを引くだけで、コメントはキャッシュから返る（GitHubは叩かない）
 */
const ACTIVE_RUN_REFRESH_MS = 30_000;
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
  issues: readonly Pick<Issue, "repositoryFullName" | "number" | "title" | "commentCount">[],
  enabled: boolean,
): { summaries: ReadonlyMap<string, CodeReviewSummary>; reload: () => void } {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, CodeReviewSummary>>(new Map());
  // 再実行を積んだ直後など、コメント件数が変わる前に取り直したいときに進める
  const [reloadToken, setReloadToken] = useState(0);
  const hasActiveRun = [...summaries.values()].some(
    (summary) => summary.runStatus === "queued" || summary.runStatus === "running",
  );

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
    const timer = hasActiveRun ? window.setInterval(load, ACTIVE_RUN_REFRESH_MS) : null;

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [targetKey, reloadToken, hasActiveRun]);

  return { summaries, reload: () => setReloadToken((value) => value + 1) };
}

/** 一覧の行から要約を引くためのキー。APIへ渡す形（`owner/repo#123`）と同じ */
export function codeReviewSummaryKey(issue: Pick<Issue, "repositoryFullName" | "number">): string {
  return `${issue.repositoryFullName}#${issue.number}`;
}
