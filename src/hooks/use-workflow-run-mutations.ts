"use client";

import { useState } from "react";

export type CancelWorkflowRunInput = {
  owner: string;
  repo: string;
  runId: number;
  force?: boolean;
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

export function useWorkflowRunMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelRun(input: CancelWorkflowRunInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/issues/workflow-run/cancel", {
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

  return { cancelRun, isSubmitting, error, setError };
}
