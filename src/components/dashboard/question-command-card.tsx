"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, SquareTerminal } from "lucide-react";

import { copyText } from "@/lib/copy-text";
import {
  describeQuestionCommandTarget,
  type QuestionCommand,
} from "@/lib/session-question-commands";
import { cn } from "@/lib/utils";

/**
 * 質問の中のコマンド1件（#5652）。**上に「どこで実行するか」、下に全幅のコピーボタン**を置き、
 * 何をコピーしてどこへ貼るのかを、地の文を読まなくても分かるようにする。
 *
 * 長いコマンドは横スクロールにせず折り返す（スマホで全体が読めるように。コピーされる内容は
 * 元の文字列のままで、折り返しの改行は入らない）。
 */
export function QuestionCommandCard({
  command,
  position,
}: {
  command: QuestionCommand;
  /** 複数あるときの「① / 2」。1件だけなら`null` */
  position: string | null;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  const { title, note } = describeQuestionCommandTarget(command);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function handleCopy() {
    const ok = await copyText(command.command);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  const label =
    state === "copied"
      ? "コピーしました"
      : state === "failed"
        ? "コピーできませんでした"
        : "コマンドをコピー";

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-muted-foreground/40 bg-background">
      <div className="flex items-center gap-2 border-b border-muted-foreground/40 bg-muted px-2.5 py-2">
        <SquareTerminal className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-bold leading-snug">{title}</span>
          {note !== null && (
            <span className="text-[11.5px] leading-snug break-all text-muted-foreground">
              {note}
            </span>
          )}
        </div>
        {position !== null && (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{position}</span>
        )}
      </div>
      <pre className="p-3 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap select-all">
        {command.command}
      </pre>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className={cn(
          "flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 border-t border-muted-foreground/40 bg-foreground text-[13px] font-bold text-background transition-opacity hover:opacity-90",
          state === "copied" && "bg-emerald-700 text-white",
          state === "failed" && "bg-destructive text-white",
        )}
      >
        {state === "copied" ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
        {label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "idle" ? "" : label}
      </span>
    </div>
  );
}
