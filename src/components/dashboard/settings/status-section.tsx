"use client";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusList } from "@/components/dashboard/github-status-list";
import type { SettingsData } from "@/hooks/use-settings-data";

type StatusSectionProps = Pick<
  SettingsData,
  "rateLimits" | "apiUsage" | "claudeUsage" | "githubStatus"
>;

/**
 * 設定の「状態」区分（#1539）。押しても何も起きない、見るだけのものを置く。
 * GitHub障害状況は独立した`GithubStatusDialog`だったが、入れ子をやめてここへ展開した。
 */
export function StatusSection({
  rateLimits,
  apiUsage,
  claudeUsage,
  githubStatus,
}: StatusSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">GitHub API使用量</p>
          <GithubRateLimitList
            data={rateLimits.data}
            isLoading={rateLimits.isLoading}
            error={rateLimits.error}
          />
          <GithubApiUsageList
            data={apiUsage.data}
            isLoading={apiUsage.isLoading}
            error={apiUsage.error}
          />
        </div>

        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Claudeプラン使用量</p>
          <ClaudeUsageCard
            data={claudeUsage.data}
            isLoading={claudeUsage.isLoading}
            error={claudeUsage.error}
            notConfigured={claudeUsage.notConfigured}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">GitHub障害状況</p>
        <GithubStatusList
          data={githubStatus.data}
          isLoading={githubStatus.isLoading}
          error={githubStatus.error}
        />
      </div>
    </div>
  );
}
