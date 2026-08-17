"use client";

import { useCallback, useState } from "react";

import type { Issue } from "@/types/issue";

/** 候補Issueと応答の突き合わせに使うキー。プロンプトにも同じ形で載る（#1788） */
export function buildIssueSearchKey(issue: Issue): string {
  return `${issue.repositoryFullName}#${issue.number}`;
}

/**
 * 検索欄の「AIで探す」を呼ぶフック（#1788）。`use-issue-quick-suggest.ts`と同じ形にしてある。
 *
 * **呼ぶのはボタンを押したときだけ。** 1回ごとにClaudeのプラン枠を消費するため、
 * 入力のたびの実行やEnterキーへの割り当ては行わない。
 *
 * `CLAUDE_CODE_OAUTH_TOKEN`が未設定の環境ではAPIが501を返す。その場合は`notConfigured`が立ち、
 * 画面はボタン自体を出さなくなる（押しても何も起きないボタンを残さない）。
 */
export function useIssueAiSearch() {
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const search = useCallback(
    async (query: string, candidates: Issue[]): Promise<string[] | null> => {
      setIsSearching(true);
      setError(null);

      try {
        const res = await fetch("/api/issues/ai-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query,
            candidates: candidates.map((issue) => ({
              key: buildIssueSearchKey(issue),
              title: issue.title,
              labels: issue.labels.map((label) => label.name),
            })),
          }),
        });
        if (res.status === 501) {
          setNotConfigured(true);
          return null;
        }
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `AI検索に失敗しました (${res.status})`);
        }
        const data = (await res.json()) as { keys?: unknown };
        const keys = new Set(
          Array.isArray(data.keys) ? data.keys.filter((key): key is string => typeof key === "string") : [],
        );
        // 返ってくるのはキー（owner/repo#番号）なので、絞り込みで使うIssueのidへ戻す
        return candidates.filter((issue) => keys.has(buildIssueSearchKey(issue))).map((issue) => issue.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsSearching(false);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { isSearching, error, notConfigured, search, clearError };
}
