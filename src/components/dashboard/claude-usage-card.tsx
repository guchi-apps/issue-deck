"use client";

import { useEffect, useState } from "react";

import { Progress } from "@/components/ui/progress";
import type { ClaudeUsage } from "@/hooks/use-claude-usage";
import { formatResetCountdown } from "@/lib/claude/format-reset";

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
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // リセットまでの残り時間を表示するため、開いている間だけ現在時刻を更新する。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
            const countdown =
              usageWindow.resetsAt !== null && now !== null
                ? formatResetCountdown(usageWindow.resetsAt, now)
                : null;
            return (
              <li key={usageWindow.key} className="rounded-lg border p-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{usageWindow.label}</span>
                  <span className="text-muted-foreground">
                    残り {Math.round(usageWindow.remainingPercent)}%
                  </span>
                </div>
                <Progress value={usageWindow.remainingPercent} />
                {countdown && (
                  <p className="mt-1 text-xs text-muted-foreground">リセット: {countdown}</p>
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
