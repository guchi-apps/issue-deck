"use client";

import { Progress } from "@/components/ui/progress";
import type { InstallationRateLimit, RateLimitResource } from "@/hooks/use-github-rate-limit";
import { useNow } from "@/hooks/use-now";
import { calcRemainingTimePercent, formatResetAt } from "@/lib/format-reset";

type GithubRateLimitListProps = {
  data: InstallationRateLimit[] | null;
  isLoading: boolean;
  error: string | null;
};

/** GitHubのレート制限は正時起点ではなく固定1時間ウィンドウ。 */
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

/**
 * 枠1つぶんの表示。RESTとGraphQLは別々に消費されるため、インストールごとに複数並ぶ（#1040）。
 * **Projects v2はGraphQL専用API**なので、進捗管理の消費はGraphQL側にしか現れない。
 */
function RateLimitResourceRow({ resource, now }: { resource: RateLimitResource; now: number | null }) {
  const remainingPercent = resource.limit > 0 ? (resource.remaining / resource.limit) * 100 : 0;
  const resetAt = now !== null ? formatResetAt(resource.reset, now) : null;
  const remainingTimePercent =
    now !== null ? calcRemainingTimePercent(resource.reset, RATE_LIMIT_WINDOW_MS, now) : null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{resource.label}</span>
        <span className="text-muted-foreground">
          残り {Math.round(remainingPercent)}% ({resource.remaining} / {resource.limit})
        </span>
      </div>
      <Progress value={remainingPercent} />
      {resetAt && <p className="mt-1 text-xs text-muted-foreground">リセット: {resetAt}</p>}
      {remainingTimePercent !== null && (
        <Progress
          value={remainingTimePercent}
          className="mt-1 h-0.5"
          indicatorClassName="bg-muted-foreground/40"
        />
      )}
    </div>
  );
}

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
          {data.map((installation) => (
            <li key={installation.accountLogin} className="rounded-lg border p-2">
              <p className="mb-1.5 text-xs font-medium">{installation.accountLogin}</p>
              <div className="flex flex-col gap-2">
                {installation.resources.map((resource) => (
                  <RateLimitResourceRow key={resource.key} resource={resource} now={now} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
