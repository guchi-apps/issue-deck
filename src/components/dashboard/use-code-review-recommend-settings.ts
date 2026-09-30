"use client";

import { useEffect, useState } from "react";

export type CodeReviewRecommendSettings = { days: number; prCount: number };

/**
 * コードレビューの提案条件（#3685）を読む。取得できるまでは`null`で、呼び出し側は既定値に倒れる。
 * `enabled`が偽の間は取りに行かない（「コードレビュー」ビューを開いたときだけ読む）。
 */
export function useCodeReviewRecommendSettings(enabled: boolean): CodeReviewRecommendSettings | null {
  const [settings, setSettings] = useState<CodeReviewRecommendSettings | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/settings/code-review-recommend")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setSettings(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return settings;
}
