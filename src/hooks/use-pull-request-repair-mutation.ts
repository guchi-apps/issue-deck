"use client";

import { useState } from "react";

import type { RepairKind } from "@/lib/github/pull-request-repair";

export type RepairPullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  kind: RepairKind;
};

function errorMessageForResponse(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  // workflow_not_found・not_repairableは「押しても起動しない理由」をそのまま出す。
  if ((errorCode === "workflow_not_found" || errorCode === "not_repairable") && message) {
    return message;
  }
  if (errorCode === "github_api_error" && message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

/** 詰まっているPRの自動修復ワークフローを起動する（#1293） */
export function usePullRequestRepairMutation() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function repairPullRequest(input: RepairPullRequestInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/pull-requests/repair", {
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

  return { repairPullRequest, isSubmitting, error, setError };
}
