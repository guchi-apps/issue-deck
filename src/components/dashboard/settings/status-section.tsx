"use client";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { GithubActionsUsage } from "@/components/dashboard/github-actions-usage";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusList } from "@/components/dashboard/github-status-list";
import type { SettingsData } from "@/hooks/use-settings-data";

type StatusSectionProps = Pick<
  SettingsData,
  "rateLimits" | "apiUsage" | "actionsUsage" | "claudeUsage" | "githubStatus"
>;

/**
 * 設定の「状態」区分（#1539）。押しても何も起きない、見るだけのものを置く。
 * GitHub障害状況は独立した`GithubStatusDialog`だったが、入れ子をやめてここへ展開した。
 *
 * 1枚目のカードの見出しは「GitHub API使用量」だったが、Actionsの実行時間（呼び出し回数では
 * ないもの）が同居した#2212で「GitHub使用量」へ変え、中を`API`・`ACTIONS`の小見出しで分けた。
 */
export function StatusSection({
  rateLimits,
  apiUsage,
  actionsUsage,
  claudeUsage,
  githubStatus,
}: StatusSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-xs font-medium text-muted-foreground">GitHub使用量</p>

          <p className="text-[10px] font-semibold tracking-wide text-muted-foreground">API</p>
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

          <div className="border-t pt-2">
            <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground">
              ACTIONS
            </p>
            <GithubActionsUsage
              data={actionsUsage.data}
              isLoading={actionsUsage.isLoading}
              error={actionsUsage.error}
              notConfigured={actionsUsage.notConfigured}
            />
          </div>
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
