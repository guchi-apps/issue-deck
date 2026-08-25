"use client";

import { Ban, Lightbulb, Loader2, PencilLine, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ManualStepFixResult } from "@/lib/claude/manual-step-fix";

/**
 * 想定外だった手作業の原因と直し案（#1869・#2299）。
 *
 * **Claudeが書いた文字列を、押さずに本文へ入れることはない。** 提案は差分（いまの本文 → 直し案）で
 * 出し、適用すると**Issue本文が書き換わってから**実行される。本文を正とする歯止め
 * （docs/multi-agent/gates.md「実行できるのは本文に書かれたコマンドだけ」）を、この経路でも保つ。
 *
 * 直せる先は2つある。
 *
 * - **コマンド**（#1869）… `## やること`のコードブロックを差し替える。実行まで続けられる
 * - **手順の説明文**（#2299）… `- [ ]`の1行を差し替える。外部ツールの画面が変わったときは
 *   コマンドではなく文言がずれているので、こちらでないと直せない。**実行はしない**
 *   （文言を直したからといって、その手順が済んだことにはならない）
 *
 * **原因の説明と出力は本文へ入れない。** このリポジトリはPUBLICで、手作業の出力には
 * シークレットが混ざりうる。本文へ入るのは提案されたコマンド・説明文の1つだけ。
 */
export function ManualStepFixPanel({
  fix,
  currentCommand,
  currentInstruction,
  isApplying,
  error,
  onApply,
  onApplyInstruction,
  onRetry,
  onDismiss,
}: {
  fix: ManualStepFixResult;
  /** いま本文に書かれているコマンド（差分の「いまの本文」）。無ければnull */
  currentCommand: string | null;
  /** いま本文に書かれている手順の説明文（#2299）。無ければ空文字 */
  currentInstruction?: string;
  isApplying: boolean;
  error: string | null;
  /** 修正案を本文へ書き戻す。`run`がtrueなら書き戻したあとに実行する */
  onApply: (command: string, options: { run: boolean }) => void;
  /** 手順の説明文の直し案を本文へ書き戻す（#2299）。渡さない場合はボタンを出さない */
  onApplyInstruction?: (instruction: string) => void;
  /** 同じコマンドをもう一度実行する（`kind: "retry"`） */
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  const showInstruction =
    fix.kind === "instruction" && fix.instruction !== null && onApplyInstruction !== undefined;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Lightbulb className="size-3.5 shrink-0" aria-hidden />
        原因と直し案
        <span className="ml-auto font-normal text-muted-foreground">Claudeの診断</span>
      </h4>

      <p className="text-xs leading-relaxed text-foreground">
        {fix.cause === "" ? "出力からは原因を特定できませんでした。" : fix.cause}
      </p>

      {fix.kind === "command" && fix.command !== null && (
        <>
          <FixDiff before={currentCommand ?? ""} after={fix.command} mono />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            適用すると、
            <strong className="font-semibold">この手作業Issueの本文を書き換えてから</strong>
            実行します（書き換えた本文はGitHubにも残ります）。実行するのは常に本文に書かれた
            コマンドです。
          </p>
        </>
      )}

      {showInstruction && (
        <>
          <FixDiff before={currentInstruction ?? ""} after={fix.instruction as string} />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            適用すると、
            <strong className="font-semibold">この手順の1行を書き換えます</strong>
            （書き換えた本文はGitHubにも残るので、次にこの手作業を開いた人も直ったものを読みます）。
            チェックは付けません。
          </p>
        </>
      )}

      {fix.advice !== null && (
        <p className="text-xs leading-relaxed text-muted-foreground">{fix.advice}</p>
      )}

      {fix.kind === "manual" && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          本文を直すだけでは進めないと判断しました。手元で対処してから、もう一度実行するか
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
        {fix.kind === "retry" && onRetry !== undefined && (
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
        {showInstruction && (
          <Button
            size="sm"
            disabled={isApplying}
            onClick={() => onApplyInstruction?.(fix.instruction as string)}
          >
            {isApplying ? <Loader2 className="animate-spin" /> : <PencilLine />}
            手順を直す
          </Button>
        )}
      </div>
    </section>
  );
}

/** いまの本文 → 直し案の差分。**適用の前に、変わるところが1画面で見えるようにする** */
function FixDiff({ before, after, mono = false }: { before: string; after: string; mono?: boolean }) {
  const font = mono ? "font-mono" : "";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold text-muted-foreground">いまの本文</span>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap rounded border bg-background p-2 text-xs leading-relaxed text-muted-foreground line-through decoration-destructive/60 ${font}`}
      >
        {before}
      </pre>
      <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
        直し案
      </span>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap rounded border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs leading-relaxed ${font}`}
      >
        {after}
      </pre>
    </div>
  );
}
