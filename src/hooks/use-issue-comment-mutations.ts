"use client";

import { useState } from "react";

import type { IssueComment } from "@/types/issue";

export type CreateCommentInput = {
  owner: string;
  repo: string;
  number: number;
  body: string;
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

async function postJson(
  url: string,
  method: "POST" | "PATCH",
  input: unknown,
): Promise<IssueComment> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`リクエストに失敗しました (${res.status})`);
  }
  const data: { comment: IssueComment } = await res.json();
  return data.comment;
}

export function useIssueCommentMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createComment(input: CreateCommentInput): Promise<IssueComment | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return await postJson("/api/issues/comments", "POST", input);
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
      return await postJson("/api/issues/comments", "PATCH", input);
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
        throw new Error(`リクエストに失敗しました (${res.status})`);
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
