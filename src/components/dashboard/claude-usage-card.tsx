"use client";

import { UsageMeter } from "@/components/dashboard/usage-meter";
import type { ClaudeUsage } from "@/hooks/use-claude-usage";
import { useNow } from "@/hooks/use-now";
import { calcElapsedTimePercent, formatResetAt, formatResetSentence } from "@/lib/format-reset";

type ClaudeUsageCardProps = {
  data: ClaudeUsage | null;
  isLoading: boolean;
  error: string | null;
  notConfigured: boolean;
};

export function ClaudeUsageCard({
  data,
  isLoading,
  error,
  notConfigured,
}: ClaudeUsageCardProps) {
  const now = useNow();

  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notConfigured && (
        <p className="text-xs text-muted-foreground">Claudeのトークンが設定されていません</p>
      )}
      {data && data.windows.length === 0 && (
        <p className="text-xs text-muted-foreground">使用量を取得できませんでした</p>
      )}
      {data && data.windows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.windows.map((usageWindow) => {
            const { resetsAt } = usageWindow;
            const hasReset = resetsAt !== null && now !== null;
            return (
              <li key={usageWindow.key} className="rounded-lg border p-2">
                <UsageMeter
                  label={usageWindow.label}
                  usedPercent={usageWindow.usedPercent}
                  remainingPercent={usageWindow.remainingPercent}
                  elapsedPercent={
                    hasReset
                      ? calcElapsedTimePercent(resetsAt, usageWindow.durationMs, now)
                      : null
                  }
                  resetSentence={hasReset ? formatResetSentence(resetsAt, now) : null}
                  resetTitle={hasReset ? formatResetAt(resetsAt, now) : null}
                  isBlocked={usageWindow.status !== null && usageWindow.status !== "allowed"}
                />
              </li>
            );
          })}
          {data.stale && (
            <li className="text-xs text-muted-foreground">
              レート制限のため最新ではない可能性があります
            </li>
          )}
        </ul>
      )}
    </>
  );
}
