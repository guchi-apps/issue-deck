"use client";

import { ExternalLink } from "lucide-react";

import { GithubStatusList } from "@/components/dashboard/github-status-list";
import { formatMonthDayTime } from "@/lib/format-date-time";
import type { SettingsData } from "@/hooks/use-settings-data";

/** GitHub公式のステータスページ。インシデントの詳細・履歴はここでしか見られない（#4064） */
const GITHUB_STATUS_PAGE_URL = "https://www.githubstatus.com/";

type StatusSectionProps = Pick<SettingsData, "githubStatus">;

/**
 * 設定の「障害状況」区分（#1539）。押しても何も起きない、見るだけのものを置く。
 *
 * GitHubの使用量（APIレート制限・呼び出し回数・Actionsの実行時間）はStatusHubで扱うため、
 * ここからは外した（#3827）。**AIの使用量もここには置かない（#2631）**——
 * 「AI使用量」画面（[`session-usage-panel.tsx`](../session-usage-panel.tsx)）が同じ値を出しており、
 * 2か所に出すと取得タイミングの違いで数字が食い違って見える。
 */
export function StatusSection({ githubStatus }: StatusSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">GitHub障害状況</p>
          <div className="flex items-baseline gap-3">
            {githubStatus.data && (
              <time
                dateTime={githubStatus.data.fetchedAt}
                className="text-xs tabular-nums text-muted-foreground"
              >
                取得 {formatMonthDayTime(githubStatus.data.fetchedAt)}
              </time>
            )}
            <a
              href={GITHUB_STATUS_PAGE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              公式ページ
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
        </div>
        <GithubStatusList
          data={githubStatus.data}
          isLoading={githubStatus.isLoading}
          error={githubStatus.error}
        />
      </div>

      {/* 開いた人が「AI使用量が消えた」で終わらないよう、移った先を書く（#2631） */}
      <p className="text-xs text-muted-foreground">
        AIの使用量（プラン枠・セッション別の消費）は「AI使用量」の画面で見られます。
      </p>
    </div>
  );
}
