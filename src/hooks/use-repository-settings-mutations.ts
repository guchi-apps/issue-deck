"use client";

import { useState } from "react";

export function useRepositorySettingsMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateAutoRetryLimit(
    repositoryId: string,
    autoRetryLimit: number,
  ): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/repositories/${repositoryId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRetryLimit }),
      });
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

  return { updateAutoRetryLimit, isSubmitting, error, setError };
}
