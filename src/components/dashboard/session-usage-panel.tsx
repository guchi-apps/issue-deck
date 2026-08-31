"use client";

import { useState, type ReactNode } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { ClaudeApiUsageList } from "@/components/dashboard/claude-api-usage-list";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { CodexUsageCard } from "@/components/dashboard/codex-usage-card";
import { Button } from "@/components/ui/button";
import type { ClaudeApiUsageSummary } from "@/hooks/use-claude-api-usage";
import type { SessionUsageResponse } from "@/hooks/use-session-usage";
import { formatDateTime, formatMonthDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { getRepoColor } from "@/lib/repo-color";
import {
  formatUsageAmount,
  formatQuotaPercent,
  formatUsageTokens,
  formatUsageUsd,
  sessionUsageCostSplit,
  sessionUsageKindLabel,
  toQuotaPercent,
  type SessionUsageEntry,
  type UsageByAgent,
  type UsageIssue,
  type UsageTotals,
} from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

/**
 * 「AI使用量」画面（#2504）。**サブPCのローカルセッションが使ったトークン**を、合計 → 推移 →
 * 内訳（リポジトリ別・種別別）→ 明細（セッション別）の順に出す。最後に、issue-deck本体の
 * AI機能が使ったAPIの内訳を置く（#2631で設定の「状態」から移設。`claudeApiUsage`を
 * 渡したときだけ出る）。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`preview-panel.tsx`と同じ切り分け）。
 * 片方にしか置かないと、外出先で「今どこにいくら使っているか」が分からない元の状態がそちらに
 * 残る。
 *
 * **金額の単位は2つある。** 既定はAPI換算のドルで、`quota`（プラン枠への換算）が取れていれば
 * 「枠の何%相当か」へ切り替えられる。**どちらも目安**で、実費でも実測の枠消費でもないことを
 * 画面の断り書きで言う。
 *
 * **表示に使うのは数値と分類だけ。** 集計元（`scripts/lib/session-usage.sh`）がやり取りの本文を
 * 読んでおらず、ここにも本文は届かない。
 */

/** 期間の選択肢（日）。APIの`ALLOWED_DAYS`と揃える */
export const SESSION_USAGE_PERIODS = [
  { days: 1, label: "1日" },
  { days: 7, label: "7日" },
  { days: 30, label: "30日" },
] as const;

export type SessionUsageUnit = "usd" | "quota";

type SessionUsagePanelProps = {
  data: SessionUsageResponse | null;
  isLoading: boolean;
  error: string | null;
  days: number;
  onChangeDays: (days: number) => void;
  onRefresh: () => void;
  /**
   * Issueを開く。リポジトリ名（ownerを除く）とIssue番号を渡す。
   * 渡さなければ行を押せない（試験・スマホの一部経路）。
   */
  onOpenIssue?: (repository: string, issueNumber: number) => void;
  /**
   * issue-deck本体のAI機能が使ったAPIの内訳（#2347・#2631で設定の「状態」から移設）。
   * **セッションの使用量とは出どころが違う**——上の集計はサブPCのpollerが押し込む記録だが、
   * これはこのアプリ自身が投げた呼び出しをメモリ上で数えたもの。渡さなければ出さない
   * （試験・スマホの一部経路）。
   */
  claudeApiUsage?: {
    data: ClaudeApiUsageSummary | null;
    isLoading: boolean;
    error: string | null;
  };
  /** スマホ向けに縮める。表をカードへ畳み、コンテキスト列を落とす */
  compact?: boolean;
  className?: string;
};

type QuotaByAgent = SessionUsageResponse["quotaByAgent"];

function formatCombinedAmount(
  byAgent: Pick<UsageByAgent, "claude" | "codex">,
  unit: SessionUsageUnit,
  quotas: QuotaByAgent,
): string {
  if (unit === "usd") {
    return formatUsageUsd(byAgent.claude.costUsd + byAgent.codex.costUsd);
  }
  const claude = toQuotaPercent(byAgent.claude.costUsd, quotas.claude);
  const codex = toQuotaPercent(byAgent.codex.costUsd, quotas.codex);
  if (claude === null && codex === null) {
    return formatUsageUsd(byAgent.claude.costUsd + byAgent.codex.costUsd);
  }
  return formatQuotaPercent((claude ?? 0) + (codex ?? 0));
}

/** 期間・単位の切り替えに使う小さなセグメント */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "px-2.5 py-1 text-xs whitespace-nowrap border-r last:border-r-0",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value
              ? "bg-accent font-semibold text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  bar,
}: {
  label: string;
  value: string;
  sub: string;
  /** 値と`sub`のあいだに挟む細い帯（コンテキストの内訳）。無ければ出さない */
  bar?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xl font-bold tabular-nums sm:text-2xl">{value}</span>
      {bar}
      <span className="text-[11px] text-muted-foreground tabular-nums">{sub}</span>
    </div>
  );
}

/**
 * 入力側の塗り分け（#2628）。**濃さは単価の順**で、いちばん薄いキャッシュ読み出しが
 * 「量は多いが安い部分」だと見ただけで分かるようにする。倍率は素の入力を1.0として、
 * キャッシュ書き込みが1.25倍（5分TTL）〜2.0倍（1時間TTL）、読み出しが0.1倍
 * （`scripts/lib/session-usage.sh`の`CACHE_WRITE_5M`・`CACHE_WRITE_1H`・`CACHE_READ`が正）。
 *
 * **キャッシュ書き込みは素の入力より高いので薄くしない。**「キャッシュ＝薄い」と2段階に
 * まとめると、単価が逆方向の書き込みまで安いものとして読めてしまう。
 *
 * GitHub Actionsの行は入力側を紫で描いているので、同じ濃さの並びを紫でも用意する。
 */
const TOKEN_COLORS = {
  local: { input: "#d97757", cacheCreate: "#a8452a", cacheRead: "#f2cdbe" },
  "github-actions": { input: "#8b5cf6", cacheCreate: "#5b21b6", cacheRead: "#d8ccf9" },
} as const;

/** 出力。入力側と系統を分けるため、入力側を塗り分けても1色のままにする */
const OUTPUT_COLOR = "#4776e6";

type TokenSegment = { key: string; label: string; value: number; color: string };

/** 1セッションぶんの内訳。入力 → キャッシュ書込 → キャッシュ読出 → 出力の順で積む */
function tokenSegments(entry: SessionUsageEntry): TokenSegment[] {
  const ramp = TOKEN_COLORS[entry.source === "github-actions" ? "github-actions" : "local"];
  return [
    { key: "input", label: "入力", value: entry.inputTokens, color: ramp.input },
    { key: "cacheCreate", label: "書込", value: entry.cacheCreateTokens, color: ramp.cacheCreate },
    { key: "cacheRead", label: "読出", value: entry.cacheReadTokens, color: ramp.cacheRead },
    { key: "output", label: "出力", value: entry.outputTokens, color: OUTPUT_COLOR },
  ];
}

/**
 * 積み上げの棒。**0でないセグメントには最小幅を与える**。素の入力はキャッシュ読み出しの
 * 1/1000ほどしかないことがあり、比率のままだと1px未満になって存在ごと消える。
 */
function TokenBar({ segments, widthPercent }: { segments: TokenSegment[]; widthPercent: number }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-muted"
      title={segments.map((segment) => `${segment.label} ${formatUsageTokens(segment.value)}`).join(" / ")}
    >
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${widthPercent}%` }}>
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className="min-w-[2px]"
              style={{
                width: `${total > 0 ? (segment.value / total) * 100 : 0}%`,
                backgroundColor: segment.color,
              }}
            />
          ))}
      </div>
    </div>
  );
}

/** 棒の下に出す内訳の数値。カードでは幅が足りないので2列へ畳む */
function TokenBreakdown({ segments, columns }: { segments: TokenSegment[]; columns?: boolean }) {
  return (
    <div
      className={cn(
        "mt-1 text-[10px] tabular-nums text-muted-foreground",
        columns ? "grid grid-cols-2 gap-x-2" : "flex flex-wrap gap-x-2.5 gap-y-0.5",
      )}
    >
      {segments.map((segment) => (
        <span key={segment.key}>
          <i
            aria-hidden
            className="mr-1 inline-block size-1.5 rounded-full"
            style={{ backgroundColor: segment.color }}
          />
          {segment.label} {formatUsageTokens(segment.value)}
        </span>
      ))}
    </div>
  );
}

/** 画面上部の凡例。単価の倍率を添えて「なぜ薄いのか」を色だけに背負わせない */
function TokenLegend() {
  const items: { color: string; label: string; rate?: string }[] = [
    { color: TOKEN_COLORS.local.input, label: "入力", rate: "1.0倍" },
    { color: TOKEN_COLORS.local.cacheCreate, label: "キャッシュ書込", rate: "1.25〜2倍" },
    { color: TOKEN_COLORS.local.cacheRead, label: "キャッシュ読出", rate: "0.1倍" },
    { color: OUTPUT_COLOR, label: "出力" },
    { color: TOKEN_COLORS["github-actions"].input, label: "GitHub Actions" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <span key={item.label}>
          <i
            aria-hidden
            className="mr-1 inline-block size-2 rounded-[2px]"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-foreground">{item.label}</span>
          {item.rate ? <span className="ml-1 tabular-nums">{item.rate}</span> : null}
        </span>
      ))}
      <span>棒の長さは最大セッションとの比較</span>
    </div>
  );
}

/** 合計タイルに挟む、期間全体のコンテキストの内訳。入力側の3つだけを見せる */
function ContextBar({ totals }: { totals: UsageTotals }) {
  const segments: TokenSegment[] = [
    { key: "input", label: "入力", value: totals.inputTokens, color: TOKEN_COLORS.local.input },
    {
      key: "cacheCreate",
      label: "書込",
      value: totals.cacheCreateTokens,
      color: TOKEN_COLORS.local.cacheCreate,
    },
    {
      key: "cacheRead",
      label: "読出",
      value: totals.cacheReadTokens,
      color: TOKEN_COLORS.local.cacheRead,
    },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    <div
      className="mt-0.5 mb-0.5 flex h-1.5 overflow-hidden rounded-full bg-muted"
      title={segments.map((segment) => `${segment.label} ${formatUsageTokens(segment.value)}`).join(" / ")}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <span
            key={segment.key}
            className="min-w-[2px]"
            style={{ width: `${(segment.value / total) * 100}%`, backgroundColor: segment.color }}
          />
        ))}
    </div>
  );
}

/**
 * 日別の棒。**いちばん新しい日だけ塗りを変える**（集計の途中で必ず低く出るため、同じ塗りだと
 * 「減った」と読めてしまう）。ライブラリを足さずCSSだけで描く。
 */
function DailyChart({
  days,
  unit,
  quotas,
  todayKey,
}: {
  days: SessionUsageResponse["byDay"];
  unit: SessionUsageUnit;
  quotas: QuotaByAgent;
  todayKey: string;
}) {
  const max = days.reduce((peak, day) => Math.max(peak, day.costUsd), 0);
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {days.map((day) => {
          const width = max > 0 ? (day.costUsd / max) * 100 : 0;
          const actionsShare = day.costUsd > 0 ? (day.bySource["github-actions"].costUsd / day.costUsd) * 100 : 0;
          const localCost = day.bySource.local.costUsd;
          const claudeShare =
            day.costUsd > 0 ? (localCost > 0 ? day.byAgent.claude.costUsd / localCost : 0) * (localCost / day.costUsd) * 100 : 0;
          const isToday = day.date === todayKey;
          return (
            <div
              key={day.date}
              className="grid grid-cols-[3.5rem_1fr_4rem] items-center gap-2 text-[10px]"
              title={`${day.date}　${formatCombinedAmount(day.byAgent, unit, quotas)}　${day.responses.toLocaleString()}応答`}
            >
              <span className="text-muted-foreground tabular-nums">
                {formatMonthDay(`${day.date}T00:00:00+09:00`)}
              </span>
              <div
                className={cn(
                  "h-2.5 overflow-hidden rounded-full bg-muted",
                  isToday && "ring-1 ring-muted-foreground/40",
                )}
              >
                <div
                  className="flex h-full overflow-hidden rounded-full"
                  style={{ width: `${width}%` }}
                >
                  <span className="bg-[#d97757]" style={{ width: `${claudeShare}%` }} />
                  <span className="bg-[#4776e6]" style={{ width: `${Math.max(0, 100 - claudeShare - actionsShare)}%` }} />
                  <span className="bg-[#8b5cf6]" style={{ width: `${actionsShare}%` }} />
                </div>
              </div>
              <span className="text-right font-semibold tabular-nums">
                {formatCombinedAmount(day.byAgent, unit, quotas)}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** リポジトリ別・種別別の内訳。`github-actions-usage.tsx`のバーと同じ形にしてある */
function Breakdown({
  title,
  hint,
  rows,
  unit,
  quotas,
  colorOf,
  maxVisibleRows,
}: {
  title: string;
  hint: string;
  rows: { key: string; label: string; sessions: number; costUsd: number; byAgent: UsageByAgent }[];
  unit: SessionUsageUnit;
  quotas: QuotaByAgent;
  colorOf?: (key: string) => string | undefined;
  maxVisibleRows?: number;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const max = rows[0]?.costUsd ?? 0;
  const visibleRows =
    maxVisibleRows !== undefined && !isExpanded ? rows.slice(0, maxVisibleRows) : rows;
  const hiddenRows = maxVisibleRows !== undefined ? Math.max(rows.length - maxVisibleRows, 0) : 0;

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">記録がありません</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleRows.map((row) => {
            const color = colorOf?.(row.key);
            return (
              <li key={row.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium">
                    {color && (
                      <span
                        aria-hidden
                        className="size-[7px] shrink-0 rounded-[2px]"
                        style={{ backgroundColor: color }}
                      />
                    )}
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {row.sessions}セッション
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {formatCombinedAmount(row.byAgent, unit, quotas)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="flex h-full"
                    style={{ width: `${max > 0 ? (row.costUsd / max) * 100 : 0}%` }}
                  >
                    <span
                      className="bg-[#d97757]"
                      style={{
                        width: `${row.costUsd > 0 ? (row.byAgent.claude.costUsd / row.costUsd) * 100 : 0}%`,
                      }}
                    />
                    <span className="flex-1 bg-[#4776e6]" />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenRows > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
        >
          {isExpanded
            ? `上位${maxVisibleRows}件のみ表示`
            : `すべて表示（残り ${hiddenRows} リポジトリ）`}
        </Button>
      )}
    </section>
  );
}

type SessionRow = { issue: UsageIssue; entry: SessionUsageEntry };

/** セッション名（Issue番号・リポジトリ・種別）と、Issue／Actionsを開く導線 */
function SessionName({
  issue,
  entry,
  onOpenIssue,
}: SessionRow & { onOpenIssue?: (repository: string, issueNumber: number) => void }) {
  const repository = issue.repository ?? "(不明)";
  const canOpen = Boolean(onOpenIssue && issue.repository && issue.issueNumber);
  return (
    <div className="flex items-start gap-1.5">
      <span aria-hidden className="mt-1 size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: getRepoColor(repository) }} />
      <div className="min-w-0">
        <div className="truncate font-semibold text-foreground">
          {issue.issueNumber === null ? "（Issue未特定）" : `#${issue.issueNumber}`} {repository}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{entry.source === "github-actions" ? "GitHub Actions" : sessionUsageKindLabel(entry.kind)} ・ {entry.agent === "claude" ? "Claude" : "Codex"}{entry.workflowName ? ` ・ ${entry.workflowName}` : ""}</div>
      </div>
      {canOpen && <Button variant="ghost" size="icon" className="size-5 shrink-0" title="Issueを開く" onClick={() => onOpenIssue?.(issue.repository as string, issue.issueNumber as number)}><ExternalLink className="size-3" /><span className="sr-only">Issueを開く</span></Button>}
      {entry.source === "github-actions" && entry.runUrl && <a href={entry.runUrl} target="_blank" rel="noreferrer" className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="Actions実行を開く" aria-label="Actions実行を開く"><ExternalLink className="size-3" /></a>}
    </div>
  );
}

/**
 * スマホ向けの明細（#2628）。**表を横スクロールさせない。**
 * 表の最小幅は46remあり、スマホでは棒と料金を同時に見られなかった。1セッション＝1カードで
 * 縦に積み、内訳の数値だけ2列へ畳む。
 */
function SessionCards({
  sessions,
  maxTokens,
  unit,
  quotas,
  onOpenIssue,
}: {
  sessions: SessionRow[];
  maxTokens: number;
  unit: SessionUsageUnit;
  quotas: QuotaByAgent;
  onOpenIssue?: (repository: string, issueNumber: number) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map(({ issue, entry }) => {
        const segments = tokenSegments(entry);
        const totalTokens = entry.contextTokens + entry.outputTokens;
        const totalWidth = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
        return (
          <li
            key={`${entry.host}:${entry.sessionId}`}
            className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-[11px]"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <SessionName issue={issue} entry={entry} onOpenIssue={onOpenIssue} />
              </div>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatUsageAmount(entry.costUsd, unit, quotas[entry.agent])}
              </span>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground">
                <span>{formatUsageTokens(totalTokens)}</span>
                <span>{Math.round(totalWidth)}%</span>
              </div>
              <div className="mt-1">
                <TokenBar segments={segments} widthPercent={totalWidth} />
              </div>
              <TokenBreakdown segments={segments} columns />
            </div>
            <div className="text-[10px] tabular-nums text-muted-foreground">
              {formatDateTime(entry.startedAt)} 〜 {formatDateTime(entry.endedAt)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** セッションごとの一覧。棒の全長を最大セッションにそろえ、セッション間の差を見せる。 */
function SessionTable({
  issues,
  unit,
  quotas,
  compact,
  onOpenIssue,
}: {
  issues: UsageIssue[];
  unit: SessionUsageUnit;
  quotas: QuotaByAgent;
  compact: boolean;
  onOpenIssue?: (repository: string, issueNumber: number) => void;
}) {
  const sessions = issues.flatMap((issue) =>
    issue.entries.map((entry) => ({ issue, entry })),
  );
  const maxTokens = sessions.reduce(
    (max, { entry }) => Math.max(max, entry.contextTokens + entry.outputTokens),
    0,
  );

  if (sessions.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  if (compact) {
    return (
      <SessionCards
        sessions={sessions}
        maxTokens={maxTokens}
        unit={unit}
        quotas={quotas}
        onOpenIssue={onOpenIssue}
      />
    );
  }

  return (
    <div className="-mx-3 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[46rem] border-collapse text-left text-[11px]">
        <caption className="sr-only">セッションごとのAI使用量</caption>
        <thead>
          <tr className="border-b bg-muted/30 text-[10px] text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-semibold">セッション</th>
            <th scope="col" className="w-[38%] px-3 py-2 font-semibold">トークン使用量（最大比）</th>
            <th scope="col" className="px-3 py-2 font-semibold">料金</th>
            <th scope="col" className="px-3 py-2 font-semibold">内訳</th>
            <th scope="col" className="px-3 py-2 font-semibold">日時</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(({ issue, entry }) => {
            const segments = tokenSegments(entry);
            const totalTokens = entry.contextTokens + entry.outputTokens;
            const totalWidth = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
            // 内訳は集計側が単価から割ったものを使う（#2626）。持っていない行だけ近似になる。
            const costSplit = sessionUsageCostSplit(entry);
            return (
              <tr key={`${entry.host}:${entry.sessionId}`} className="border-b last:border-b-0">
                <td className="max-w-[15rem] px-3 py-3 align-top">
                  <SessionName issue={issue} entry={entry} onOpenIssue={onOpenIssue} />
                </td>
                <td className="px-3 py-3 align-middle">
                  <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground"><span>{formatUsageTokens(totalTokens)}</span><span>{Math.round(totalWidth)}%</span></div>
                  <div className="mt-1">
                    <TokenBar segments={segments} widthPercent={totalWidth} />
                  </div>
                  <TokenBreakdown segments={segments} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-top font-semibold tabular-nums">{formatUsageAmount(entry.costUsd, unit, quotas[entry.agent])}</td>
                <td className="whitespace-nowrap px-3 py-3 align-top tabular-nums text-muted-foreground" title={costSplit.approximate ? "このセッションは金額の内訳を記録していないため、トークン数の比で按分した概算です（キャッシュの単価差を反映できていません）" : undefined}>入力 {costSplit.approximate ? "約" : ""}{formatUsageUsd(costSplit.inputCostUsd)}<br />出力 {costSplit.approximate ? "約" : ""}{formatUsageUsd(costSplit.outputCostUsd)}</td>
                <td className="whitespace-nowrap px-3 py-3 align-top tabular-nums text-muted-foreground">{formatDateTime(entry.startedAt)}<br />〜 {formatDateTime(entry.endedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 明細に出すIssueの件数。全部並べると30日で数百行になり、上位が読めなくなる */
const VISIBLE_ISSUES_STEP = 20;

export function SessionUsagePanel({
  data,
  isLoading,
  error,
  days,
  onChangeDays,
  onRefresh,
  onOpenIssue,
  claudeApiUsage,
  compact = false,
  className,
}: SessionUsagePanelProps) {
  const [unit, setUnit] = useState<SessionUsageUnit>("usd");
  const [visibleIssues, setVisibleIssues] = useState(VISIBLE_ISSUES_STEP);

  const quotas = data?.quotaByAgent ?? { claude: null, codex: null };
  const hasQuota = Boolean(quotas.claude || quotas.codex);
  const effectiveUnit: SessionUsageUnit = hasQuota ? unit : "usd";

  const totals = data?.totals;
  const perResponseUsd = totals && totals.responses > 0 ? totals.costUsd / totals.responses : 0;
  const avgContext =
    totals && totals.responses > 0 ? Math.round(totals.contextTokens / totals.responses) : 0;
  const implementation = data?.byKind.find((kind) => kind.key === "implementation");
  const planReview = data?.byKind.find((kind) => kind.key === "plan-review");
  const todayKey = data?.byDay.at(-1)?.date ?? "";
  const issues = data?.byIssue ?? [];
  const agentCostSub = data
    ? `Claude ${formatUsageUsd(data.totalsByAgent.claude.costUsd)}・Codex ${formatUsageUsd(data.totalsByAgent.codex.costUsd)}・Actions ${formatUsageUsd(data.totalsBySource["github-actions"].costUsd)}`
    : "";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">AI使用量</h2>
          <p className="text-[11px] text-muted-foreground">
            {/* **いつの報告かを見出しに出す。** 材料はpollerが5分おきに押し込む記録で、
                開いた瞬間の値ではない（古いまま止まっていることに気付けるようにする） */}
            サブPCのClaude・CodexセッションとGitHub Actionsが使ったトークン
            {data?.reportedAt
              ? `　/　${data.hosts.join("・") || "subpc"} から ${formatRelativeDate(data.reportedAt)}`
              : ""}
          </p>
        </div>
        <Segmented
          ariaLabel="集計する期間"
          options={SESSION_USAGE_PERIODS.map((period) => ({
            value: period.days,
            label: period.label,
          }))}
          value={days}
          onChange={onChangeDays}
        />
        <Segmented
          ariaLabel="金額の単位"
          options={[
            { value: "usd" as const, label: "$" },
            { value: "quota" as const, label: "枠%" },
          ]}
          value={effectiveUnit}
          onChange={setUnit}
        />
        <Button variant="outline" size="icon" className="size-7" onClick={onRefresh} title="更新">
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          <span className="sr-only">更新</span>
        </Button>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <TokenLegend />

      {/* プラン枠そのもの。**逆算した「枠%」ではなく実測のメーター**で、両方を並べて置く */}
      <section className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold">Claude プラン枠</p>
          <ClaudeUsageCard
            data={data?.planUsage.claude ?? null}
            isLoading={isLoading && !data}
            error={null}
            notConfigured={data?.planNotConfigured.claude ?? false}
          />
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold">Codex プラン枠</p>
          <CodexUsageCard
            data={data?.planUsage.codex ?? null}
            isLoading={isLoading && !data}
            error={null}
            notConfigured={data?.planNotConfigured.codex ?? false}
          />
        </div>
      </section>

      {isLoading && !data && <p className="text-xs text-muted-foreground">読み込み中...</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Tile
              label={effectiveUnit === "quota" ? "枠換算" : "従量課金"}
              value={formatCombinedAmount(data.totalsByAgent, effectiveUnit, quotas)}
              sub={agentCostSub}
            />
            <Tile
              label="GitHub Actions"
              value={formatUsageAmount(data.totalsBySource["github-actions"].costUsd, effectiveUnit, quotas.claude)}
              sub={`${data.totalsBySource["github-actions"].sessions.toLocaleString()}実行・Claude Code`}
            />
            <Tile
              label="応答"
              value={data.totals.responses.toLocaleString()}
              /* コンテキストタイルのsubを内訳に使ったので、1応答あたりの平均はこちらへ寄せる */
              sub={`1応答 ${formatUsageUsd(perResponseUsd)}・平均 ${formatUsageTokens(avgContext)}`}
            />
            <Tile
              label="コンテキスト"
              value={formatUsageTokens(data.totals.contextTokens)}
              bar={<ContextBar totals={data.totals} />}
              sub={`入力 ${formatUsageTokens(data.totals.inputTokens)}・書込 ${formatUsageTokens(data.totals.cacheCreateTokens)}・読出 ${formatUsageTokens(data.totals.cacheReadTokens)}`}
            />
            <Tile
              label="セッション"
              value={data.totals.sessions.toLocaleString()}
              sub={`実装 ${implementation?.sessions ?? 0}・計画レビュー ${planReview?.sessions ?? 0}・Actions ${data.totalsBySource["github-actions"].sessions}`}
            />
          </div>

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">日別</span>
              <span className="text-[11px] text-muted-foreground">
                いちばん新しい日は集計中（枠線付き）
              </span>
            </div>
            <DailyChart
              days={data.byDay}
              unit={effectiveUnit}
              quotas={quotas}
              todayKey={todayKey}
            />
          </section>

          <div className={cn("grid gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
            <Breakdown
              title="リポジトリ別"
              hint={`${data.byRepository.length}リポジトリ`}
              rows={data.byRepository.map((row) => ({
                key: row.key,
                label: row.key || "(不明)",
                sessions: row.sessions,
                costUsd: row.costUsd,
                byAgent: row.byAgent,
              }))}
              unit={effectiveUnit}
              quotas={quotas}
              colorOf={(key) => getRepoColor(key || "(不明)")}
              maxVisibleRows={5}
            />
            <Breakdown
              title="種別別"
              hint="作業ディレクトリで判定"
              rows={data.byKind.map((row) => ({
                key: row.key,
                label: sessionUsageKindLabel(row.key),
                sessions: row.sessions,
                costUsd: row.costUsd,
                byAgent: row.byAgent,
              }))}
              unit={effectiveUnit}
              quotas={quotas}
            />
          </div>

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">Issue・セッション別</span>
              <span className="text-[11px] text-muted-foreground">
                セッションごと・棒の長さは最大セッション比
              </span>
            </div>
            {issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                記録がありません。サブPCまたはGitHub Actionsから報告されると出ます。
              </p>
            ) : (
              <>
                <SessionTable
                  issues={issues.slice(0, visibleIssues)}
                  unit={effectiveUnit}
                  quotas={quotas}
                  compact={compact}
                  onOpenIssue={onOpenIssue}
                />
                {issues.length > visibleIssues && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-7 text-xs"
                    onClick={() => setVisibleIssues((prev) => prev + VISIBLE_ISSUES_STEP)}
                  >
                    もっと見る（残り {issues.length - visibleIssues} 件）
                  </Button>
                )}
                {/* 明細は上位200件で切ってある（応答の大きさを抑えるため）。
                    **合計・内訳には入っている**ので、そこだけを断る */}
                {data.omittedIssues > 0 && issues.length <= visibleIssues && (
                  <p className="pt-1 text-center text-[11px] text-muted-foreground">
                    ほか {data.omittedIssues.toLocaleString()} 件（合計{" "}
                    {formatUsageUsd(data.omittedIssueCostUsd)}
                    ）は明細に出していません。上の合計・内訳には入っています。
                  </p>
                )}
              </>
            )}
          </section>
          <p className="text-[10px] text-muted-foreground">
            GitHub Actionsの使用量はClaude Code実行後に報告されます。反映に時間がかかる場合があり、料金はAPI換算の目安です。
          </p>
        </>
      )}

      {/* issue-deck本体のAI機能が使ったAPIの内訳（#2631で設定の「状態」から移設）。
          **`data`の外に置く**——セッションの記録がまだ届いていなくても、このアプリ自身の
          消費は数えられているので出せる */}
      {claudeApiUsage && (
        <section className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold">API呼び出し（issue-deck本体）</span>
            <span className="text-[11px] text-muted-foreground">
              Issueの要約・検索・文章整理などで使った量
            </span>
          </div>
          <ClaudeApiUsageList
            data={claudeApiUsage.data}
            isLoading={claudeApiUsage.isLoading}
            error={claudeApiUsage.error}
          />
        </section>
      )}
    </div>
  );
}
