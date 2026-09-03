"use client";

import { useState } from "react";

export type MergePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
};

function errorMessageForResponse(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

export function usePullRequestMergeMutation() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mergePullRequest(input: MergePullRequestInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/issues/pull-request-merge", {
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

  return { mergePullRequest, closePullRequest, isSubmitting, error, setError };
}
