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

/** 転記へ戻ったときに出す最終観測時刻（日本時間の「9/18 03:12」） */
function formatObservedAt(ms: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

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
          {/* Claudeの週間枠と同じ先頭行に置く（#3195）。 */}
          {data.windows.filter((window) => window.key === "secondary").map((window) => {
            // リセット後の使用量が分からない枠は、推定の0%を出さずにそう書く（#3052）
            if (window.expired) {
              return (
                <li key={window.key} className="rounded-lg border p-2">
                  <p className="text-sm font-semibold">{window.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    リセット後の使用量はまだ取得できていません
                  </p>
                </li>
              );
            }
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
          {/* ops-dashboardから読めていないことに気付けるようにする（#3052。設定漏れで
              転記へ戻ったまま、実際と違う値が出続けていた） */}
          {data.source === "transcript" && (
            <li className="text-xs text-muted-foreground">
              ops-dashboardから取得できないため、サブPCの転記（最終観測 {formatObservedAt(data.fetchedAt)}）を表示しています
            </li>
          )}
        </ul>
      )}
    </>
  );
}
