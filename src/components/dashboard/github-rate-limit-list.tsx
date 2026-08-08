"use client";

import { Progress } from "@/components/ui/progress";
import type { InstallationRateLimit } from "@/hooks/use-github-rate-limit";
import { useNow } from "@/hooks/use-now";
import { calcRemainingTimePercent, formatResetAt } from "@/lib/format-reset";

type GithubRateLimitListProps = {
  data: InstallationRateLimit[] | null;
  isLoading: boolean;
  error: string | null;
};

/** GitHub REST APIのコアレート制限は正時起点ではなく固定1時間ウィンドウ。 */
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

export function GithubRateLimitList({ data, isLoading, error }: GithubRateLimitListProps) {
  const now = useNow();

  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">連携中のインストールがありません</p>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.map((rateLimit) => {
            const remainingPercent =
              rateLimit.limit > 0 ? (rateLimit.remaining / rateLimit.limit) * 100 : 0;
            const resetAt = now !== null ? formatResetAt(rateLimit.reset, now) : null;
            const remainingTimePercent =
              now !== null
                ? calcRemainingTimePercent(rateLimit.reset, RATE_LIMIT_WINDOW_MS, now)
                : null;
            return (
              <li key={rateLimit.accountLogin} className="rounded-lg border p-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{rateLimit.accountLogin}</span>
                  <span className="text-muted-foreground">
                    残り {Math.round(remainingPercent)}% ({rateLimit.remaining} /{" "}
                    {rateLimit.limit})
                  </span>
                </div>
                <Progress value={remainingPercent} />
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
        </ul>
      )}
    </>
  );
}
