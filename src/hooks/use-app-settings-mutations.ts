"use client";

import { useState } from "react";

import type { ClaudeModel } from "@/lib/app-settings";

export function useAppSettingsMutations() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updateAutoRetryLimit(autoRetryLimit: number): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/auto-retry", {
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

  async function updateClaudeModel(
    claudeModel: ClaudeModel,
    claudeModelAssist: ClaudeModel,
  ): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/claude-model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeModel, claudeModelAssist }),
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

  // サブPCで同時に走らせるジョブ本数の上限（#1179）。CPUの載せ替えで適正値が変わるため、
  // 定数ではなく設定値として持つ決めごと（#1176）に対応する。
  async function updateDispatchConcurrency(dispatchConcurrency: number): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/dispatch-concurrency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatchConcurrency }),
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

  return {
    updateAutoRetryLimit,
    updateClaudeModel,
    updateDispatchConcurrency,
    isSubmitting,
    error,
    setError,
  };
}
