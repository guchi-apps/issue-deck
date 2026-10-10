"use client";

import { UsageMeter, UsageMeterSkeleton } from "@/components/dashboard/usage-meter";
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
  // 2列表示ではCodexの週間枠と先頭行を揃える。取得元の配列順に依存せず、
  // 週間枠を先に置く（#3195）。
  const windows = [...(data?.windows ?? [])].sort((a, b) => {
    const order = (key: string) => (key === "7d" ? 0 : key === "5h" ? 1 : 2);
    return order(a.key) - order(b.key);
  });

  return (
    <>
      {isLoading && (
        // 実物の並び（週間 → 5時間）と同じ2行を、枠つきで先に描く（#3304）
        <ul className="flex flex-col gap-2">
          {["週間", "5時間"].map((label) => (
            <li key={label} className="rounded-lg border p-2">
              <UsageMeterSkeleton label={label} />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notConfigured && (
        <p className="text-xs text-muted-foreground">Claudeのトークンが設定されていません</p>
      )}
      {data && windows.length === 0 && (
        <p className="text-xs text-muted-foreground">使用量を取得できませんでした</p>
      )}
      {data && windows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {windows.map((usageWindow) => {
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
