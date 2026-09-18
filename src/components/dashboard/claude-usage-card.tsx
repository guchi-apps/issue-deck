"use client";

import { UsageMeter } from "@/components/dashboard/usage-meter";
import type { ClaudeUsage } from "@/hooks/use-claude-usage";
import { useNow } from "@/hooks/use-now";
import { calcElapsedTimePercent, formatResetAt, formatResetSentence } from "@/lib/format-reset";
import { formatUsageUsd, type QuotaEstimate } from "@/lib/session-usage-view";

type ClaudeUsageCardProps = {
  data: ClaudeUsage | null;
  isLoading: boolean;
  error: string | null;
  notConfigured: boolean;
  /**
   * 5時間枠の実測換算レート（#2988）。求まらない・渡されない場合は注記を出さない
   * （試験・「AI使用量」以外からの呼び出し向けにオプショナルにしてある）。
   */
  quotaEstimate?: QuotaEstimate | null;
};

/**
 * 5時間枠メーター下の実測換算の注記（#2988）。**5時間枠にしか付けない**
 * （週間枠は今回のIssueの対象外——issue-deckが把握する消費と週間枠の対応は精度がさらに落ちる）。
 */
function QuotaNote({ quotaEstimate }: { quotaEstimate: QuotaEstimate }) {
  return (
    <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed dark:border-amber-900 dark:bg-amber-950/40">
      直近5時間の実測換算：
      <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">
        1% ≈ {formatUsageUsd(quotaEstimate.usdPerPercent)}
      </span>
      （セッション・Actions合計 {formatUsageUsd(quotaEstimate.windowCostUsd)}）
    </div>
  );
}

export function ClaudeUsageCard({
  data,
  isLoading,
  error,
  notConfigured,
  quotaEstimate,
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
                {usageWindow.key === "5h" && quotaEstimate && (
                  <QuotaNote quotaEstimate={quotaEstimate} />
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
