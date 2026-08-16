"use client";

import { useCallback, useState } from "react";

import type { QuickSuggestKind, QuickSuggestResult } from "@/lib/quick-issue";

export type QuickSuggestRequest = {
  body: string;
  kind: QuickSuggestKind;
  /** すでに決まっているリポジトリ（人が入力ステップで選んだ場合・リポジトリ別の画面から開いた場合） */
  repositoryFullName?: string | null;
  /**
   * `repositoryFullName`が**人の指定**かどうか（#1733）。
   * 真のときAPIはリポジトリの推定を行わず、タイトル・ラベルだけを生成する。
   * 画面から渡しただけ（リポジトリ別の画面から開いた）の場合は偽で、推定は従来どおり行う（#1710）。
   */
  repositoryPinned?: boolean;
};

/**
 * クイック起票（#1605）の一括推定を呼ぶフック。`use-issue-suggest.ts`と同じ形にしてある。
 *
 * **失敗しても呼び出し側は先へ進む。** 戻り値の`null`は「推定できなかった」であって
 * 「作成できない」ではなく、画面は空欄の確認ステップを出す。
 */
export function useIssueQuickSuggest() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const generate = useCallback(
    async (request: QuickSuggestRequest): Promise<QuickSuggestResult | null> => {
      setIsGenerating(true);
      setError(null);
      setNotConfigured(false);

      try {
        const res = await fetch("/api/issues/quick-suggest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if (res.status === 501) {
          setNotConfigured(true);
          return null;
        }
        if (!res.ok) {
          const data: { message?: string } = await res.json().catch(() => ({}));
          throw new Error(data.message ?? `自動入力に失敗しました (${res.status})`);
        }
        return (await res.json()) as QuickSuggestResult;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsGenerating(false);
      }
    },
    [],
  );

  return { isGenerating, error, notConfigured, generate };
}
