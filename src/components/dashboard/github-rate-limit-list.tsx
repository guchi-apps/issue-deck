"use client";

import { UsageMeter } from "@/components/dashboard/usage-meter";
import type { InstallationRateLimit, RateLimitResource } from "@/hooks/use-github-rate-limit";
import { useNow } from "@/hooks/use-now";
import { calcElapsedTimePercent, formatResetAt, formatResetSentence } from "@/lib/format-reset";

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
  // GitHubは消費数も返すので、残量からの引き算ではなくそちらを使う。
  const usedPercent = resource.limit > 0 ? (resource.used / resource.limit) * 100 : 0;

  return (
    <UsageMeter
      label={resource.label}
      labelMuted
      usedPercent={usedPercent}
      remainingPercent={remainingPercent}
      remainingSuffix={`(${resource.remaining.toLocaleString()} / ${resource.limit.toLocaleString()})`}
      elapsedPercent={
        now !== null ? calcElapsedTimePercent(resource.reset, RATE_LIMIT_WINDOW_MS, now) : null
      }
      resetSentence={now !== null ? formatResetSentence(resource.reset, now) : null}
      resetTitle={now !== null ? formatResetAt(resource.reset, now) : null}
    />
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
