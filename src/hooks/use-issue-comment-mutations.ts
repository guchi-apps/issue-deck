"use client";

import { useState } from "react";

import { GITHUB_REAUTH_REQUIRED_MESSAGE } from "@/lib/github/reauth-message";
import type { IssueComment } from "@/types/issue";

export type CreateCommentInput = {
  owner: string;
  repo: string;
  number: number;
  body: string;
  /** 明示的な質問操作のみ既存ホストへ配送する。 */
  askQuestion?: boolean;
};

export type UpdateCommentInput = {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
};

export type DeleteCommentInput = {
  owner: string;
  repo: string;
  commentId: number;
};

function errorMessageForResponse(
  status: number,
  errorCode: string | undefined,
  message: string | undefined,
): string {
  if (errorCode === "github_reauth_required") {
    return GITHUB_REAUTH_REQUIRED_MESSAGE;
  }
  if (message) {
    return message;
  }
  return `リクエストに失敗しました (${status})`;
}

async function postJson(
  url: string,
  method: "POST" | "PATCH",
  input: unknown,
): Promise<{ comment: IssueComment; warning?: string }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data: { error?: string; message?: string } = await res.json().catch(() => ({}));
    throw new Error(errorMessageForResponse(res.status, data.error, data.message));
  }
  const data: { comment: IssueComment; warning?: string } = await res.json();
  return data;
}

export function useIssueCommentMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createComment(input: CreateCommentInput): Promise<(IssueComment & { deliveryWarning?: string }) | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await postJson("/api/issues/comments", "POST", input);
      if (result.warning) setError(result.warning);
      return { ...result.comment, ...(result.warning ? { deliveryWarning: result.warning } : {}) };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateComment(input: UpdateCommentInput): Promise<IssueComment | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return (await postJson("/api/issues/comments", "PATCH", input)).comment;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteComment(input: DeleteCommentInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        owner: input.owner,
        repo: input.repo,
        commentId: String(input.commentId),
      });
      const res = await fetch(`/api/issues/comments?${params.toString()}`, { method: "DELETE" });
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

  return { createComment, updateComment, deleteComment, isSubmitting, error, setError };
}
