"use client";

import { useCallback, useRef, useState } from "react";

import type { ManualStepFixResult } from "@/lib/claude/manual-step-fix";

/**
 * 失敗した代行実行の原因と修正案を取りに行く（#1869）。
 *
 * **送るのはジョブのidだけ。** コマンドも出力もサーバーが読み直す（`/api/manual-steps/fix`）。
 * 呼ぶのは失敗したときだけで、**出力にはシークレットが混ざりうる**ため、呼ぶかどうかは
 * 承認パネルの同意（`use-manual-step-autorun.ts`の`consent`）に従う。
 *
 * 同じジョブについて二度呼ばない（ポーリングのたびに枠を消費しない）。
 */
export type ManualStepFixState = {
  jobId: string;
  fix: ManualStepFixResult;
  /** いま本文に書かれているコマンド。差分の「いまの本文」として出す */
  currentCommand: string;
};

export function useManualStepFix() {
  const [state, setState] = useState<ManualStepFixState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef<string | null>(null);

  const diagnose = useCallback(async (jobId: string) => {
    if (requested.current === jobId) return;
    requested.current = jobId;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/manual-steps/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(describeFixError(json?.error));
        return;
      }
      const json = (await res.json()) as { fix: ManualStepFixResult; currentCommand: string };
      setState({ jobId, fix: json.fix, currentCommand: json.currentCommand });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** 診断の結果を片付ける。**もう一度調べ直せるようにする**ので、覚えたジョブidも忘れる */
  const dismiss = useCallback(() => {
    requested.current = null;
    setState(null);
    setError(null);
  }, []);

  return { state, isLoading, error, diagnose, dismiss };
}

function describeFixError(code: string | undefined): string {
  switch (code) {
    case "not_configured":
      return "Claudeの認証情報（CLAUDE_CODE_OAUTH_TOKEN）が設定されていないため、原因を調べられません。";
    case "body_changed":
      return "本文が変わったため調べられませんでした。画面を更新してください。";
    case "not_found":
      return "この実行結果が見つかりませんでした。";
    default:
      return "原因を調べられませんでした。";
  }
}
