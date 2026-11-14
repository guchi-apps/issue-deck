"use client";

import { UsageMeter, UsageMeterSkeleton } from "@/components/dashboard/usage-meter";
import type { GithubRestUsage } from "@/hooks/use-github-rest-usage";
import { useNow } from "@/hooks/use-now";
import { calcElapsedTimePercent, formatResetAt, formatResetSentence } from "@/lib/format-reset";

/** GitHub RESTの枠は1時間単位 */
const WINDOW_MS = 60 * 60_000;
const VISIBLE_FEATURES = 4;

type Props = {
  data: GithubRestUsage | null;
  isLoading: boolean;
  error: string | null;
};

/**
 * GitHub App（REST）の使用量カード（#5391）。メーターはプラン枠と同じ`UsageMeter`。
 * 実消費（GitHubが数えた値）と、このサーバーの計測・用途別の内訳を並べる。
 */
export function GithubRestUsageCard({ data, isLoading, error }: Props) {
  const now = useNow();

  if (isLoading) {
    return (
      <div className="rounded-lg border p-2">
        <UsageMeterSkeleton label="REST" />
      </div>
    );
  }
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return null;

  const limits = data.rateLimits;
  const features = data.features.filter((feature) => feature.last60min > 0).slice(0, VISIBLE_FEATURES);

  return (
    <div className="flex flex-col gap-2">
      {limits.length === 0 && (
        <p className="text-xs text-muted-foreground">GitHub Appのインストールがありません</p>
      )}
      {limits.map((limit) => {
        if (limit.error !== undefined) {
          return (
            <p key={limit.accountLogin} className="text-xs text-muted-foreground">
              {limit.accountLogin}: 使用量を取得できませんでした
            </p>
          );
        }
        const hasReset = now !== null;
        return (
          <div key={limit.accountLogin} className="rounded-lg border p-2">
            <UsageMeter
              label={limit.accountLogin}
              usedPercent={limit.limit > 0 ? (limit.used / limit.limit) * 100 : 0}
              remainingPercent={limit.limit > 0 ? (limit.remaining / limit.limit) * 100 : 0}
              remainingSuffix={`(${limit.remaining.toLocaleString()} / ${limit.limit.toLocaleString()})`}
              elapsedPercent={hasReset ? calcElapsedTimePercent(limit.reset, WINDOW_MS, now) : null}
              resetSentence={hasReset ? formatResetSentence(limit.reset, now) : null}
              resetTitle={hasReset ? formatResetAt(limit.reset, now) : null}
            />
            <p className="mt-1.5 text-[10px] text-muted-foreground tabular-nums">
              このサーバーの計測 {limit.measuredInWindow.toLocaleString()}件 / それ以外（Actionsなど）{" "}
              {limit.unmeasuredInWindow.toLocaleString()}件
            </p>
          </div>
        );
      })}
      {features.length > 0 && (
        <div className="text-[11px]">
          <p className="mb-0.5 text-muted-foreground">用途別（直近60分）</p>
          <ul>
            {features.map((feature) => (
              <li key={feature.key} className="flex justify-between gap-2">
                <span className="truncate">{feature.label}</span>
                <span className="tabular-nums">{feature.last60min.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
