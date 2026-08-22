"use client";

import { useState } from "react";

import { GITHUB_REAUTH_REQUIRED_MESSAGE } from "@/lib/github/reauth-message";
import type { Issue } from "@/types/issue";

export type CreateIssueInput = {
  repositoryFullName: string;
  title: string;
  body: string;
  labels: string[];
  assignee: string | null;
};

export type UpdateIssueInput = {
  repositoryFullName: string;
  number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned";
  labels?: string[];
  assignee?: string | null;
  /**
   * クローズと同時に付けるクローズ理由ラベル（`90.Close: *`。#2178）。
   * `state: "closed"`のときだけ効き、リポジトリに定義が無ければ付与を諦めてクローズだけ行う。
   */
  closeReasonLabel?: string;
};

export type DeleteIssueInput = {
  repositoryFullName: string;
  number: number;
};

export type TransferIssueInput = {
  repositoryFullName: string;
  number: number;
  newRepositoryFullName: string;
};

function errorMessageForResponse(status: number, data: { error?: string; message?: string }): string {
  if (data.error === "github_reauth_required") {
    return GITHUB_REAUTH_REQUIRED_MESSAGE;
  }
  return data.error === "github_api_error" && data.message
    ? data.message
    : `リクエストに失敗しました (${status})`;
}

async function postJson(url: string, method: "POST" | "PATCH", input: unknown): Promise<Issue> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
    throw new Error(errorMessageForResponse(res.status, data));
  }
  const data: { issue: Issue } = await res.json();
  return data.issue;
}

export function useIssueMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createIssue(input: CreateIssueInput): Promise<Issue | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return await postJson("/api/issues", "POST", input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateIssue(input: UpdateIssueInput): Promise<Issue | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return await postJson("/api/issues", "PATCH", input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function transferIssue(input: TransferIssueInput): Promise<Issue | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return await postJson("/api/issues/transfer", "POST", input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteIssue(input: DeleteIssueInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        repositoryFullName: input.repositoryFullName,
        number: String(input.number),
      });
      const res = await fetch(`/api/issues?${params.toString()}`, { method: "DELETE" });
      if (!res.ok) {
        const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
        throw new Error(errorMessageForResponse(res.status, data));
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { createIssue, updateIssue, transferIssue, deleteIssue, isSubmitting, error, setError };
}
