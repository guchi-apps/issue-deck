"use client";

import { useCallback, useState } from "react";

import type { IssueOrderResult } from "@/lib/claude/issue-order";
import { buildIssueOrderCandidates } from "@/lib/issue-order-view";
import type { Issue } from "@/types/issue";

/**
 * 未着手のIssueの着手順をClaudeに決めさせるフック（#1853）。
 * `use-issue-ai-search.ts`と同じ形にしてある。
 *
 * **呼ぶのはボタンを押したときだけ。** 1回ごとにClaudeのプラン枠を消費するため、
 * 一覧を開いた時点やポーリングでは呼ばない。
 *
 * `CLAUDE_CODE_OAUTH_TOKEN`が未設定の環境ではAPIが501を返す。その場合は`notConfigured`が立ち、
 * 画面は入口自体を出さなくなる（押しても何も起きないボタンを残さない）。
 */
export function useIssueOrder() {
  const [isDeciding, setIsDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const decide = useCallback(async (issues: Issue[]): Promise<IssueOrderResult | null> => {
    const candidates = buildIssueOrderCandidates(issues, new Date());
    if (candidates.length === 0) return { overview: "", order: [], skip: [] };

    setIsDeciding(true);
    setError(null);

    try {
      const res = await fetch("/api/issues/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidates }),
      });
      if (res.status === 501) {
        setNotConfigured(true);
        return null;
      }
      if (!res.ok) {
        const data: { message?: string } = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `着手順の判定に失敗しました (${res.status})`);
      }
      return (await res.json()) as IssueOrderResult;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsDeciding(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { isDeciding, error, notConfigured, decide, clearError };
}
