"use client";

import { UsageMeter } from "@/components/dashboard/usage-meter";
import { useNow } from "@/hooks/use-now";
import type { CodexUsage } from "@/lib/dispatch/codex-usage";
import { calcElapsedTimePercent, formatResetAt, formatResetSentence } from "@/lib/format-reset";

type Props = {
  data: CodexUsage | null;
  isLoading: boolean;
  error: string | null;
  notConfigured: boolean;
};

export function CodexUsageCard({ data, isLoading, error, notConfigured }: Props) {
  const now = useNow();
  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notConfigured && (
        <p className="text-xs text-muted-foreground">Codex使用量の報告がまだありません</p>
      )}
      {data && (
        <ul className="flex flex-col gap-2">
          {/* Claudeの5時間枠と同じ高さを確保するが、Codexにはその枠がないため中身は出さない。
              **1列（スマホ）では揃える相手が無いので出さない**（#2666。横に並ぶ2列時だけ出す） */}
          <li aria-hidden="true" className="hidden invisible rounded-lg border p-2 sm:block">
            <div className="h-[52px]" />
          </li>
          {data.windows.filter((window) => window.key === "secondary").map((window) => {
            const hasReset = now !== null;
            return (
              <li key={window.key} className="rounded-lg border p-2">
                <UsageMeter
                  label={window.label}
                  usedPercent={window.usedPercent}
                  remainingPercent={window.remainingPercent}
                  elapsedPercent={
                    hasReset
                      ? calcElapsedTimePercent(window.resetsAt, window.durationMs, now)
                      : null
                  }
                  resetSentence={hasReset ? formatResetSentence(window.resetsAt, now) : null}
                  resetTitle={hasReset ? formatResetAt(window.resetsAt, now) : null}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
