"use client";

import { useState } from "react";

import { codeReviewSummaryKey, useCodeReviewReports } from "@/hooks/use-code-review-reports";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { findCodeReviewJobForIssue } from "@/lib/dispatch/dispatch-job";
import {
  findLatestCodeReviewReport,
  isCodeReviewIssue,
  resolveCodeReviewRunStatus,
  summarizeCodeReviewComments,
  type CodeReviewReport,
  type CodeReviewRunJob,
  type CodeReviewRunStatus,
} from "@/lib/github/code-review";
import type { Issue, IssueComment } from "@/types/issue";

export type CodeReviewRunState = {
  report: CodeReviewReport | null;
  runStatus: CodeReviewRunStatus;
  job: CodeReviewRunJob | null;
  rerun: () => Promise<void>;
  isRerunning: boolean;
  rerunError: string | null;
};

/**
 * Issue詳細（PC・スマホ）のコードレビューの状態（#4116）。
 *
 * **一覧と同じ関数（`resolveCodeReviewRunStatus`）で決める。** コメントは詳細が持っている最新の
 * ものを使い、実行の記録（ジョブ）は一覧と同じ要約API（`GET /api/issues/code-review-reports`）から
 * 受け取る——画面の`dispatch.jobs`は直近24時間ぶんしか持たず（`FINISHED_JOB_RETENTION_MS`）、
 * それより前に見送られたレビューが「レビュー中」に戻って見えていた（#4116の直接原因の1つ）。
 * 要約が届くまでの間だけ`dispatch.jobs`の記録で埋める。
 *
 * レビューIssueでなければ（`issue`が`null`でも）`null`を返す。
 */
export function useCodeReviewRun(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "commentCount"> | null,
  comments: readonly Pick<IssueComment, "body">[],
  dispatch: DispatchStateHandle,
): CodeReviewRunState | null {
  const enabled = issue !== null && isCodeReviewIssue(issue);
  const { summaries, reload } = useCodeReviewReports(enabled && issue ? [issue] : [], enabled);
  const [isRerunning, setIsRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  if (!enabled || !issue) return null;
  const target = issue;

  const remote = summaries.get(codeReviewSummaryKey(issue));
  const fallbackJob = findCodeReviewJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  const job: CodeReviewRunJob | null = remote
    ? (remote.job ?? null)
    : fallbackJob
      ? {
          id: fallbackJob.id,
          status: fallbackJob.status,
          message: fallbackJob.message,
          targetHost: fallbackJob.targetHost,
          createdAt: fallbackJob.createdAt,
          startedAt: fallbackJob.startedAt,
          heartbeatAt: null,
          finishedAt: fallbackJob.finishedAt,
        }
      : null;
  const local = summarizeCodeReviewComments(comments);
  // 要約が届く前で記録も無いときは「状態不明」と出さず、待っている扱いにする（一瞬で切り替わる）
  const runStatus: CodeReviewRunStatus =
    !remote && !job && local.awaitingResult ? "running" : resolveCodeReviewRunStatus(local, job);

  async function rerun() {
    setIsRerunning(true);
    setRerunError(null);
    try {
      const res = await fetch("/api/code-review/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: target.repositoryFullName, issue: target.number }),
      });
      if (!res.ok) {
        const data: { message?: string; error?: string } = await res.json().catch(() => ({}));
        setRerunError(data.message ?? data.error ?? `再実行を積めませんでした（HTTP ${res.status}）`);
      }
    } catch (error) {
      setRerunError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRerunning(false);
      reload();
      dispatch.refresh();
    }
  }

  return {
    report: findLatestCodeReviewReport(comments),
    runStatus,
    job,
    rerun,
    isRerunning,
    rerunError,
  };
}
