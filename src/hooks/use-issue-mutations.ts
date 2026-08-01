"use client";

import { useState } from "react";

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
};

async function postJson(url: string, method: "POST" | "PATCH", input: unknown): Promise<Issue> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`リクエストに失敗しました (${res.status})`);
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

  return { createIssue, updateIssue, isSubmitting, error, setError };
}
