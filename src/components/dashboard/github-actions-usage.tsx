"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { ActionsUsageEntry, ActionsUsagePeriod } from "@/hooks/use-github-actions-usage";
import { formatMonthDay } from "@/lib/format-date-time";

type GithubActionsUsageProps = {
  data: ActionsUsageEntry[] | null;
  isLoading: boolean;
  error: string | null;
};

/** 「今日」と「今月」。上のAPI消費（今時／過去1日）と軸が違うのは、Actionsの課金が暦月で締まるため */
type ActionsUsageMode = "today" | "thisMonth";

function formatMinutes(minutes: number): string {
  return `${Math.round(minutes).toLocaleString()}分`;
}

/** 課金額。1セント未満でも0にせず、切り上げて「$0.01」と出す（発生していること自体が要点のため） */
function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "$0.01";
  return `$${amount.toFixed(2)}`;
}

/**
 * リポジトリ別の内訳。**課金が発生しているリポジトリは金額を添えてバーの色を変える。**
 * publicリポジトリの実行は分数が大きくても無料なので、分数の大小だけでは「請求に効くもの」を
 * 見分けられない（[docs/github-billing.md](../../../docs/github-billing.md)）。
 */
function RepositoryBreakdown({ period }: { period: ActionsUsagePeriod }) {
  const max = period.repositories[0]?.minutes ?? 0;

  return (
    <ul className="flex flex-col gap-2">
      {period.repositories.map((repository) => (
        <li key={repository.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="truncate font-medium">
              {repository.name}
              {repository.netAmount > 0 && (
                <span className="ml-1.5 rounded-full border border-destructive/40 px-1.5 text-[9px] text-destructive tabular-nums">
                  {formatUsd(repository.netAmount)}
                </span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatMinutes(repository.minutes)}
            </span>
          </div>
          <Progress
            value={max > 0 ? (repository.minutes / max) * 100 : 0}
            indicatorClassName={repository.netAmount > 0 ? "bg-destructive" : undefined}
          />
        </li>
      ))}
      {period.otherRepositoryCount > 0 && (
        <li className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="truncate text-muted-foreground">
              ほか{period.otherRepositoryCount}リポジトリ
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatMinutes(period.otherMinutes)}
            </span>
          </div>
          <Progress value={max > 0 ? (period.otherMinutes / max) * 100 : 0} />
        </li>
      )}
    </ul>
  );
}

function ActionsUsageEntryRow({ entry, mode }: { entry: ActionsUsageEntry; mode: ActionsUsageMode }) {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const detailId = useId();

  if (entry.unsupported) {
    return (
      <p className="text-xs text-muted-foreground">
        個人アカウントのインストール（{entry.accountLogin}）では表示できません
      </p>
    );
  }

  if (!entry.usage) {
    return (
      <p className="text-xs text-muted-foreground">
        消費量を取得できませんでした（{entry.errorStatus ?? "エラー"}）。organizationの課金レポートを読む権限が要ります
      </p>
    );
  }

  const usage = entry.usage;
  const period = mode === "today" ? usage.today : usage.thisMonth;
  const modeLabel =
    mode === "today"
      ? `今日（${formatMonthDay(usage.todayStartedAt)}）`
      : `今月（${usage.month}月）`;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={isDetailOpen}
        aria-controls={detailId}
        onClick={() => setIsDetailOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="truncate tabular-nums">
          {modeLabel} <span className="font-semibold text-foreground">{formatMinutes(period.minutes)}</span>
          {" · 課金 "}
          {formatUsd(period.netAmount)}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${isDetailOpen ? "rotate-90" : ""}`}
        />
      </button>
      {isDetailOpen && (
        <div id={detailId} className="flex flex-col gap-2">
          {period.repositories.length === 0 ? (
            <p className="text-xs text-muted-foreground">この期間の実行はありません</p>
          ) : (
            <RepositoryBreakdown period={period} />
          )}
          <p className="text-[10px] text-muted-foreground">
            ストレージ {Math.round(usage.storageGigabyteHours).toLocaleString()} GB時 ・ 課金{" "}
            {formatUsd(usage.storageNetAmount)}
            <br />
            GitHubの課金レポート（UTC基準の暦月）。publicリポジトリの実行は無料枠を消費せず、赤いバーが
            実際に課金された分です。レポートへの反映は最大1日遅れます。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub Actionsの消費量（#2212）。
 *
 * 見出し「Actions」は呼び出し元（`settings/status-section.tsx`）が出すため、
 * このコンポーネント自体は持たない（GithubApiUsageListと同じ約束）。
 */
export function GithubActionsUsage({ data, isLoading, error }: GithubActionsUsageProps) {
  const [mode, setMode] = useState<ActionsUsageMode>("thisMonth");

  if (isLoading) return <p className="text-xs text-muted-foreground">読み込み中...</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return null;
  if (data.length === 0) {
    return <p className="text-xs text-muted-foreground">連携中のインストールがありません</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "today"}
          onClick={() => setMode("today")}
        >
          今日
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "thisMonth"}
          onClick={() => setMode("thisMonth")}
        >
          今月
        </Button>
      </div>
      {data.map((entry) => (
        <div key={entry.accountLogin} className="flex flex-col gap-1">
          {data.length > 1 && !entry.unsupported && (
            <p className="text-[10px] font-medium text-muted-foreground">{entry.accountLogin}</p>
          )}
          <ActionsUsageEntryRow entry={entry} mode={mode} />
        </div>
      ))}
    </div>
  );
}
