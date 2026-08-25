"use client";

import { useCallback, useRef, useState } from "react";

import type { ManualStepFixResult } from "@/lib/claude/manual-step-fix";
import type { ManualStepCommandKind } from "@/lib/manual-step-command";
import type { ManualStepTroubleReport } from "@/lib/manual-step-trouble";

/**
 * 想定外だった手作業の原因と直し案を取りに行く（#1869・#2299）。
 *
 * 入口は2つある。どちらも`POST /api/manual-steps/fix`で、**コマンドも出力もサーバーが
 * 読み直す**（画面が送った文字列について診断させない）。
 *
 * - `diagnose(jobId)` … 失敗した代行実行（#1869）。**送るのはジョブのidだけ。**
 *   呼ぶのは失敗したときだけで、**出力にはシークレットが混ざりうる**ため、呼ぶかどうかは
 *   承認パネルの同意（`use-manual-step-autorun.ts`の`consent`）に従う。同じジョブについて
 *   二度呼ばない（ポーリングのたびに枠を消費しない）
 * - `report(input)` … 人が「うまくいかない」から書いたつまずき（#2299）。代行できない手順は
 *   出力が画面に届かないので、分類と自由記述を送る。**貼り付けた内容は同意があるときだけ**
 *   載せる（載せるかどうかを決めるのは呼び出し側）。書き直して押し直せるよう、同じ対象でも
 *   呼ぶたびに調べ直す
 */
export type ManualStepFixState = {
  /** どの対象について調べた結果か。代行実行はジョブのid、つまずきの報告は`kind:line` */
  key: string;
  fix: ManualStepFixResult;
  /** いま本文に書かれているコマンド。差分の「いまの本文」として出す（無ければnull） */
  currentCommand: string | null;
  /** いま本文に書かれている手順の説明文（#2299）。直せる文言が無ければ空文字 */
  currentInstruction: string;
};

/** つまずきの報告から調べるときの引数（#2299） */
export type ManualStepFixReportInput = {
  repositoryFullName: string;
  number: number;
  kind: ManualStepCommandKind;
  /** `## やること`の手順の行、または確認コマンドの開きフェンスの行。無ければnull */
  line: number | null;
  report: ManualStepTroubleReport;
};

export function manualStepFixKey(kind: ManualStepCommandKind, line: number | null): string {
  return `${kind}:${line ?? "-"}`;
}

export function useManualStepFix() {
  const [state, setState] = useState<ManualStepFixState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef<string | null>(null);

  const request = useCallback(async (key: string, payload: unknown) => {
    requested.current = key;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/manual-steps/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(describeFixError(json?.error));
        return;
      }
      const json = (await res.json()) as {
        fix: ManualStepFixResult;
        currentCommand: string | null;
        currentInstruction: string;
      };
      setState({
        key,
        fix: json.fix,
        currentCommand: json.currentCommand,
        currentInstruction: json.currentInstruction,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const diagnose = useCallback(
    async (jobId: string) => {
      if (requested.current === jobId) return;
      await request(jobId, { jobId });
    },
    [request],
  );

  const report = useCallback(
    async (input: ManualStepFixReportInput) => {
      await request(manualStepFixKey(input.kind, input.line), {
        repositoryFullName: input.repositoryFullName,
        number: input.number,
        kind: input.kind,
        line: input.line,
        report: input.report,
      });
    },
    [request],
  );

  /** 診断の結果を片付ける。**もう一度調べ直せるようにする**ので、覚えた対象も忘れる */
  const dismiss = useCallback(() => {
    requested.current = null;
    setState(null);
    setError(null);
  }, []);

  return { state, isLoading, error, diagnose, report, dismiss };
}

function describeFixError(code: string | undefined): string {
  switch (code) {
    case "not_configured":
      return "Claudeの認証情報（CLAUDE_CODE_OAUTH_TOKEN）が設定されていないため、原因を調べられません。";
    case "body_changed":
      return "本文が変わったため調べられませんでした。画面を更新してください。";
    case "not_found":
      return "この実行結果が見つかりませんでした。";
    case "invalid_request":
      return "起きたことが書かれていないため調べられませんでした。";
    default:
      return "原因を調べられませんでした。";
  }
}
