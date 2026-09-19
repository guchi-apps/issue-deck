"use client";

import { useState } from "react";

export type UpdatePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
};

/** PR詳細の「編集」（#3161）。タイトル・本文をまとめて保存する */
export function usePullRequestUpdateMutation() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updatePullRequest(input: UpdatePullRequestInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/pull-requests/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
        throw new Error(
          data.error === "github_api_error" && data.message
            ? data.message
            : `リクエストに失敗しました (${res.status})`,
        );
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { updatePullRequest, isSubmitting, error, setError };
}
