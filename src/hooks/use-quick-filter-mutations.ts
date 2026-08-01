"use client";

import { useState } from "react";

import type { QuickFilter, QuickFilterInput } from "@/types/quick-filter";

export function useQuickFilterMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createQuickFilter(input: QuickFilterInput): Promise<QuickFilter | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/quick-filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 409) {
        setError("同じ名前のフィルターが既にあります");
        return null;
      }
      if (!res.ok) {
        throw new Error(`リクエストに失敗しました (${res.status})`);
      }
      const data: { quickFilter: QuickFilter } = await res.json();
      return data.quickFilter;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { createQuickFilter, isSubmitting, error, setError };
}
