"use client";

import { GithubActionsUsage } from "@/components/dashboard/github-actions-usage";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusList } from "@/components/dashboard/github-status-list";
import type { SettingsData } from "@/hooks/use-settings-data";

type StatusSectionProps = Pick<
  SettingsData,
  "rateLimits" | "apiUsage" | "actionsUsage" | "githubStatus"
>;

/**
 * 設定の「状態」区分（#1539）。押しても何も起きない、見るだけのものを置く。
 * GitHub障害状況は独立した`GithubStatusDialog`だったが、入れ子をやめてここへ展開した。
 *
 * 1枚目のカードの見出しは「GitHub API使用量」だったが、Actionsの実行時間（呼び出し回数では
 * ないもの）が同居した#2212で「GitHub使用量」へ変え、中を`API`・`ACTIONS`の小見出しで分けた。
 *
 * **AIの使用量はここに置かない（#2631）。** 2枚目に「AI使用量」カード（Claude・Codexのプラン枠と
 * 機能別のAPI消費内訳）があったが、プラン枠のメーターは「AI使用量」画面
 * （[`session-usage-panel.tsx`](../session-usage-panel.tsx)）が同じ`ClaudeUsageCard`・
 * `CodexUsageCard`で出しており、**同じ値が2か所に出ていた**。片方を見て枠の残りを判断した後に
 * もう片方を開くと、取得タイミングの違いで数字が食い違って見える。ここには置かず、
 * 機能別のAPI消費内訳（ここにしか無かったもの）ごとAI使用量画面へ移した。
 */
export function StatusSection({
  rateLimits,
  apiUsage,
  actionsUsage,
  githubStatus,
}: StatusSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* AI使用量カードが抜けて1枚になったので、カードの中を2カラムに割る（#2631）。
          外側のgridを残すと、広い画面で右半分が空いたままになる */}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-xs font-medium text-muted-foreground">GitHub使用量</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
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
          </div>

          {/* 狭い画面では上下に並ぶので、区切り線は1カラムのときだけ出す */}
          <div className="flex flex-col gap-2 border-t pt-2 sm:border-t-0 sm:pt-0">
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground">ACTIONS</p>
            <GithubActionsUsage
              data={actionsUsage.data}
              isLoading={actionsUsage.isLoading}
              error={actionsUsage.error}
              notConfigured={actionsUsage.notConfigured}
            />
          </div>
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

      {/* 開いた人が「AI使用量が消えた」で終わらないよう、移った先を書く（#2631） */}
      <p className="text-xs text-muted-foreground">
        AIの使用量（プラン枠・セッション別の消費・API呼び出しの内訳）は「AI使用量」の画面で見られます。
      </p>
    </div>
  );
}
