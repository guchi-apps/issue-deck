"use client";

import { Ban, Lightbulb, Loader2, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ManualStepFixResult } from "@/lib/claude/manual-step-fix";

/**
 * 失敗した手作業の原因と修正案（#1869）。
 *
 * **Claudeが書いたコマンドを、押さずに実行することはない。** 提案は差分（いまの本文 → 修正案）で
 * 出し、適用すると**Issue本文のコマンドが書き換わってから**実行される。本文を正とする歯止め
 * （docs/multi-agent/gates.md「実行できるのは本文に書かれたコマンドだけ」）を、この経路でも保つ。
 *
 * **原因の説明と出力は本文へ入れない。** このリポジトリはPUBLICで、手作業の出力には
 * シークレットが混ざりうる。本文へ入るのは提案されたコマンドの1行だけ。
 */
export function ManualStepFixPanel({
  fix,
  currentCommand,
  isApplying,
  error,
  onApply,
  onRetry,
  onDismiss,
}: {
  fix: ManualStepFixResult;
  /** いま本文に書かれているコマンド（差分の「いまの本文」） */
  currentCommand: string;
  isApplying: boolean;
  error: string | null;
  /** 修正案を本文へ書き戻す。`run`がtrueなら書き戻したあとに実行する */
  onApply: (command: string, options: { run: boolean }) => void;
  /** 同じコマンドをもう一度実行する（`kind: "retry"`） */
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Lightbulb className="size-3.5 shrink-0" aria-hidden />
        原因と修正案
        <span className="ml-auto font-normal text-muted-foreground">Claudeの診断</span>
      </h4>

      <p className="text-xs leading-relaxed text-foreground">
        {fix.cause === "" ? "出力からは原因を特定できませんでした。" : fix.cause}
      </p>

      {fix.kind === "command" && fix.command !== null && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">いまの本文</span>
            <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed text-muted-foreground line-through decoration-destructive/60">
              {currentCommand}
            </pre>
            <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              修正案
            </span>
            <pre className="overflow-x-auto rounded border border-emerald-500/40 bg-emerald-500/5 p-2 font-mono text-xs leading-relaxed">
              {fix.command}
            </pre>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            適用すると、
            <strong className="font-semibold">この手作業Issueの本文を書き換えてから</strong>
            実行します（書き換えた本文はGitHubにも残ります）。実行するのは常に本文に書かれた
            コマンドです。
          </p>
        </>
      )}

      {fix.advice !== null && <p className="text-xs leading-relaxed text-muted-foreground">{fix.advice}</p>}

      {fix.kind === "manual" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          コマンドを直すだけでは通らないと判断しました。手元で対処してから、もう一度実行するか
          「実行した・次へ」で進めてください。
        </p>
      )}

      {error !== null && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss} disabled={isApplying}>
          <Ban />
          破棄する
        </Button>
        {fix.kind === "retry" && (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={isApplying}>
            <RotateCcw />
            もう一度実行
          </Button>
        )}
        {fix.kind === "command" && fix.command !== null && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={isApplying}
              onClick={() => onApply(fix.command as string, { run: false })}
            >
              本文だけ直す
            </Button>
            <Button
              size="sm"
              disabled={isApplying}
              onClick={() => onApply(fix.command as string, { run: true })}
            >
              {isApplying ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              修正を適用して実行
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
