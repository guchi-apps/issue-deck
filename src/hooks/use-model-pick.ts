"use client";

import { useCallback, useRef, useState } from "react";

import type { ModelPickResult } from "@/lib/claude/model-pick";

/**
 * 「実装を開始」ダイアログの「おまかせ」（#2723）。**押したときだけ呼ぶ。**
 *
 * ダイアログを開いただけでは呼ばない——選ぶかどうか分からない時点でAPIを叩くと、
 * 開くたびにアプリ内AIの枠を消費することになる。
 *
 * 同じIssueで押し直した場合は**覚えている結果をそのまま出す**（`resultRef`）。
 * チップを行き来しただけで判定が何度も走らないようにするためで、
 * 選び直したいときはダイアログを開き直せば消える。
 */
export function useModelPick() {
  const [result, setResult] = useState<ModelPickResult | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 直近の結果。React stateだけだと、押し直しの判定に使うたびに再描画へ依存してしまう
  const resultRef = useRef<ModelPickResult | null>(null);

  const reset = useCallback(() => {
    resultRef.current = null;
    setResult(null);
    setIsPicking(false);
    setError(null);
  }, []);

  const pick = useCallback(
    async (params: {
      repositoryFullName: string;
      number: number;
      /** 承認済みの計画コメント（画面が既に持っていれば渡す） */
      planComment?: string;
    }): Promise<ModelPickResult | null> => {
      if (resultRef.current) return resultRef.current;

      const [owner, repo] = params.repositoryFullName.split("/");
      setIsPicking(true);
      setError(null);

      try {
        const res = await fetch("/api/issues/model-pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            repo,
            number: params.number,
            planComment: params.planComment,
          }),
        });
        if (!res.ok) {
          throw new Error(`モデルを選べませんでした (${res.status})`);
        }
        const data: ModelPickResult = await res.json();
        resultRef.current = data;
        setResult(data);
        return data;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsPicking(false);
      }
    },
    [],
  );

  return { result, isPicking, error, pick, reset };
}
