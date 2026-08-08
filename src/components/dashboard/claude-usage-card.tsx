"use client";

import { Progress } from "@/components/ui/progress";
import type { ClaudeUsage } from "@/hooks/use-claude-usage";
import { useNow } from "@/hooks/use-now";
import { calcRemainingTimePercent, formatResetAt } from "@/lib/format-reset";

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
            const resetAt =
              usageWindow.resetsAt !== null && now !== null
                ? formatResetAt(usageWindow.resetsAt, now)
                : null;
            const remainingTimePercent =
              usageWindow.resetsAt !== null && now !== null
                ? calcRemainingTimePercent(usageWindow.resetsAt, usageWindow.durationMs, now)
                : null;
            return (
              <li key={usageWindow.key} className="rounded-lg border p-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{usageWindow.label}</span>
                  <span
                    className={
                      usageWindow.status !== null && usageWindow.status !== "allowed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    残り {Math.round(usageWindow.remainingPercent)}%
                  </span>
                </div>
                <Progress value={usageWindow.remainingPercent} />
                {resetAt && (
                  <p className="mt-1 text-xs text-muted-foreground">リセット: {resetAt}</p>
                )}
                {remainingTimePercent !== null && (
                  <Progress
                    value={remainingTimePercent}
                    className="mt-1 h-0.5"
                    indicatorClassName="bg-muted-foreground/40"
                  />
                )}
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
