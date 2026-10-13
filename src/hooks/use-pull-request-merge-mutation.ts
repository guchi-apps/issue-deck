"use client";

import { useState } from "react";

export type MergePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  /** 要修正の判定を読んだうえで、このHEADのまま通すという明示確認（#4377）。HEADが動けばサーバーが拒否する */
  acknowledgeReviewSha?: string;
};

/** サーバーが要修正の確認を求めて返した409。画面は古い確認を流用せず、最新のHEADで確認し直す */
export type ReviewConfirmationRequired = {
  reviewLabel: string;
  headSha: string;
  /** 送った確認が古いHEADのものだった */
  acknowledgedStale: boolean;
};

function errorMessageForResponse(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  // 新方式の候補の工程検査（#4635）。不足している工程と次の操作をそのまま見せる
  if ((errorCode === "github_api_error" || errorCode?.startsWith("rc_")) && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

export function usePullRequestMergeMutation() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewConfirmation, setReviewConfirmation] = useState<ReviewConfirmationRequired | null>(null);

  async function mergePullRequest(input: MergePullRequestInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    setReviewConfirmation(null);
    try {
      const res = await fetch("/api/issues/pull-request-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data: { error?: string; message?: string } & Partial<ReviewConfirmationRequired> =
          await res.json().catch(() => ({}));
        if (res.status === 409 && data.error === "review_confirmation_required") {
          setReviewConfirmation({
            reviewLabel: data.reviewLabel ?? "要修正",
            headSha: data.headSha ?? "",
            acknowledgedStale: data.acknowledgedStale === true,
          });
          return false;
        }
        throw new Error(errorMessageForResponse(res.status, data.error, data.message));
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  /** マージせずにPRをクローズする（#2780「マージしない」）。状態は`mergePullRequest`と共有する（同時に両方は押せないため） */
  async function closePullRequest(input: MergePullRequestInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/issues/pull-request-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
        throw new Error(errorMessageForResponse(res.status, data.error, data.message));
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return {
    mergePullRequest,
    closePullRequest,
    isSubmitting,
    error,
    setError,
    reviewConfirmation,
    clearReviewConfirmation: () => setReviewConfirmation(null),
  };
}
