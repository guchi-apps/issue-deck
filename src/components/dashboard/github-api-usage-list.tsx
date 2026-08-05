"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { GithubApiUsage } from "@/hooks/use-github-api-usage";
import { useNow } from "@/hooks/use-now";
import { formatDuration } from "@/lib/format-duration";

type GithubApiUsageListProps = {
  data: GithubApiUsage | null;
  isLoading: boolean;
  error: string | null;
};

/** 用途ごとに表示するエンドポイント内訳の件数 */
const ENDPOINTS_PER_FEATURE = 3;

/**
 * 表示する集計モード。
 * `currentHour`はGitHub REST APIのコアレート制限に合わせた、正時起点の固定1時間ウィンドウ
 * （ローリング60分ではない）。`last24h`は直近24時間のローリングウィンドウ。
 */
type UsageMode = "currentHour" | "last24h";

/**
 * 用途別のGitHub API消費の内訳。
 * GitHubは消費の内訳を返さないため、アプリが自分で発信したリクエストを数えた値を表示する。
 * 見出し「GitHub API使用量」は呼び出し元（topbar.tsx / mobile-settings-screen.tsx）が
 * GithubRateLimitListと共通で表示するため、このコンポーネント自体は見出しを持たない（#474）。
 */
export function GithubApiUsageList({ data, isLoading, error }: GithubApiUsageListProps) {
  const now = useNow();
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [mode, setMode] = useState<UsageMode>("currentHour");
  const detailId = useId();

  if (isLoading) return <p className="text-xs text-muted-foreground">読み込み中...</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return null;
  if (data.features.length === 0) {
    return <p className="text-xs text-muted-foreground">まだ消費が記録されていません</p>;
  }

  const measuredMs = now !== null ? now - data.measuringSince : null;
  const currentHourLabel = `${new Date(data.currentHourStartedAt).getHours()}:00〜`;
  const modeLabel = mode === "currentHour" ? `今時（${currentHourLabel}）` : "過去1日";
  const total = mode === "currentHour" ? data.totalCurrentHour : data.totalLast24h;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "currentHour"}
          onClick={() => setMode("currentHour")}
        >
          今時（{currentHourLabel}）
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "last24h"}
          onClick={() => setMode("last24h")}
        >
          過去1日
        </Button>
      </div>
      <button
        type="button"
        aria-expanded={isDetailOpen}
        aria-controls={detailId}
        onClick={() => setIsDetailOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
      >
        <span>
          {modeLabel} {total.toLocaleString()}回
        </span>
        <ChevronRight className={`size-3 shrink-0 transition-transform ${isDetailOpen ? "rotate-90" : ""}`} />
      </button>
      {isDetailOpen && (
        <div id={detailId} className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {data.features.map((feature) => {
              const count = mode === "currentHour" ? feature.currentHour : feature.last24h;
              const sharePercent = total > 0 ? (count / total) * 100 : 0;
              return (
                <li key={feature.key} className="rounded-lg border p-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{feature.label}</span>
                    <span className="shrink-0 text-muted-foreground">{count.toLocaleString()}</span>
                  </div>
                  <Progress value={sharePercent} />
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {feature.endpoints.slice(0, ENDPOINTS_PER_FEATURE).map((endpoint) => (
                      <li
                        key={endpoint.endpoint}
                        className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                      >
                        <span className="truncate" title={endpoint.endpoint}>
                          {endpoint.endpoint}
                        </span>
                        <span className="shrink-0">
                          {(mode === "currentHour" ? endpoint.currentHour : endpoint.last24h).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-muted-foreground">
            「{modeLabel}」の呼び出し回数。
            {measuredMs !== null && `計測期間は直近${formatDuration(measuredMs)}（`}
            {measuredMs === null && "（"}
            アプリの再起動でリセットされます）
          </p>
        </div>
      )}
    </div>
  );
}
