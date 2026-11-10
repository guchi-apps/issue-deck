"use client";

import { useState } from "react";

import type { FineGrainedTokenInput } from "@/types/fine-grained-token";

import { clientErrorMessage } from "@/lib/client-error-message";
export function useFineGrainedTokenMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createFineGrainedToken(input: FineGrainedTokenInput): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/fine-grained-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error("同じ名前のトークンが既に登録されています");
        throw new Error(`登録に失敗しました (${res.status})`);
      }
      return true;
    } catch (err) {
      setError(clientErrorMessage(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function deleteFineGrainedToken(id: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/fine-grained-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`削除に失敗しました (${res.status})`);
      return true;
    } catch (err) {
      setError(clientErrorMessage(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { createFineGrainedToken, deleteFineGrainedToken, isSubmitting, error, setError };
}
