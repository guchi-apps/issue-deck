"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { CodexUsageCard } from "@/components/dashboard/codex-usage-card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { SessionUsageResponse } from "@/hooks/use-session-usage";
import type { SessionUsageAgent } from "@/lib/dispatch/session-usage";
import { formatDateTime, formatMonthDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { getRepoColor } from "@/lib/repo-color";
import {
  formatUsageAmount,
  formatUsageTokens,
  formatUsageUsd,
  sessionUsageKindLabel,
  type QuotaScale,
  type SessionUsageEntry,
  type UsageIssue,
} from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

/**
 * 「AI使用量」画面（#2504）。**サブPCのローカルセッションが使ったトークン**を、合計 → 推移 →
 * 内訳（リポジトリ別・種別別）→ 明細（Issue別・その中のtmuxセッション別）の順に出す。
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
  agent: SessionUsageAgent;
  onChangeAgent: (agent: SessionUsageAgent) => void;
  onChangeDays: (days: number) => void;
  onRefresh: () => void;
  /**
   * Issueを開く。リポジトリ名（ownerを除く）とIssue番号を渡す。
   * 渡さなければ行を押せない（試験・スマホの一部経路）。
   */
  onOpenIssue?: (repository: string, issueNumber: number) => void;
  /** スマホ向けに縮める。表をカードへ畳み、コンテキスト列を落とす */
  compact?: boolean;
  className?: string;
};

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

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xl font-bold tabular-nums sm:text-2xl">{value}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">{sub}</span>
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
  quota,
  todayKey,
}: {
  days: { date: string; costUsd: number; responses: number }[];
  unit: SessionUsageUnit;
  quota: QuotaScale | null;
  todayKey: string;
}) {
  const max = days.reduce((peak, day) => Math.max(peak, day.costUsd), 0);
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  return (
    <>
      <div className="flex h-24 items-end gap-[3px]">
        {days.map((day) => {
          const height = max > 0 ? Math.max(2, (day.costUsd / max) * 100) : 2;
          const isToday = day.date === todayKey;
          return (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end"
              title={`${day.date}　${formatUsageAmount(day.costUsd, unit, quota)}　${day.responses.toLocaleString()}応答`}
            >
              <div
                className={cn(
                  "w-full rounded-t-[3px]",
                  isToday ? "border border-primary bg-primary/25" : "bg-primary",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{formatMonthDay(`${days[0].date}T00:00:00+09:00`)}</span>
        <span>{formatMonthDay(`${days[days.length - 1].date}T00:00:00+09:00`)}</span>
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
  quota,
  colorOf,
}: {
  title: string;
  hint: string;
  rows: { key: string; label: string; sessions: number; costUsd: number }[];
  unit: SessionUsageUnit;
  quota: QuotaScale | null;
  colorOf?: (key: string) => string | undefined;
}) {
  const max = rows[0]?.costUsd ?? 0;

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
          {rows.map((row) => {
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
                    {formatUsageAmount(row.costUsd, unit, quota)}
                  </span>
                </div>
                <Progress value={max > 0 ? (row.costUsd / max) * 100 : 0} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 転記1本ぶんの明細（Issueの行を開いたときだけ出す） */
function SessionRow({
  entry,
  unit,
  quota,
  compact,
}: {
  entry: SessionUsageEntry;
  unit: SessionUsageUnit;
  quota: QuotaScale | null;
  compact: boolean;
}) {
  const models = entry.models.map((model) => model.replace(/^claude-/, "")).join(" / ");
  return (
    <div className="flex items-baseline gap-2 py-0.5 pl-5 text-[11px] text-muted-foreground tabular-nums">
      <span className="shrink-0 font-medium text-foreground">{sessionUsageKindLabel(entry.kind)}</span>
      {!compact && <span className="shrink-0">{models || "-"}</span>}
      <span className="truncate">
        {formatDateTime(entry.startedAt)} → {formatDateTime(entry.endedAt)}
      </span>
      <span className="ml-auto shrink-0">{entry.responses.toLocaleString()}応答</span>
      {!compact && <span className="shrink-0">{formatUsageTokens(entry.contextTokens)}</span>}
      <span className="shrink-0 font-semibold text-foreground">
        {formatUsageAmount(entry.costUsd, unit, quota)}
      </span>
    </div>
  );
}

/** Issue1件ぶんの行。押すと転記ごとの明細が開く */
function IssueRow({
  issue,
  unit,
  quota,
  compact,
  onOpenIssue,
}: {
  issue: UsageIssue;
  unit: SessionUsageUnit;
  quota: QuotaScale | null;
  compact: boolean;
  onOpenIssue?: (repository: string, issueNumber: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const repository = issue.repository ?? "(不明)";
  const canOpen = Boolean(onOpenIssue && issue.repository && issue.issueNumber);

  return (
    <li className="border-b py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <span
            aria-hidden
            className="size-[7px] shrink-0 rounded-[2px]"
            style={{ backgroundColor: getRepoColor(repository) }}
          />
          <span className="shrink-0 font-semibold tabular-nums">
            {issue.issueNumber === null ? "（Issue未特定）" : `#${issue.issueNumber}`}
          </span>
          <span className="truncate text-muted-foreground">{repository}</span>
          <span className="shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground">
            {sessionUsageKindLabel(issue.kinds[0] ?? "other")}
            {issue.kinds.length > 1 ? ` +${issue.kinds.length - 1}` : ""}
          </span>
        </button>

        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {issue.sessions}セッション
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {issue.responses.toLocaleString()}応答
        </span>
        {!compact && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatUsageTokens(issue.contextTokens)}
          </span>
        )}
        <span className="w-16 shrink-0 text-right font-semibold tabular-nums">
          {formatUsageAmount(issue.costUsd, unit, quota)}
        </span>
        {canOpen && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            title="Issueを開く"
            onClick={() => onOpenIssue?.(issue.repository as string, issue.issueNumber as number)}
          >
            <ExternalLink className="size-3" />
            <span className="sr-only">Issueを開く</span>
          </Button>
        )}
      </div>

      {isOpen && (
        <div className="mt-1 border-l pl-1">
          {issue.entries.map((entry) => (
            <SessionRow
              key={`${entry.host}:${entry.sessionId}`}
              entry={entry}
              unit={unit}
              quota={quota}
              compact={compact}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** 明細に出すIssueの件数。全部並べると30日で数百行になり、上位が読めなくなる */
const VISIBLE_ISSUES_STEP = 20;

export function SessionUsagePanel({
  data,
  isLoading,
  error,
  days,
  agent,
  onChangeAgent,
  onChangeDays,
  onRefresh,
  onOpenIssue,
  compact = false,
  className,
}: SessionUsagePanelProps) {
  const [unit, setUnit] = useState<SessionUsageUnit>("usd");
  const [visibleIssues, setVisibleIssues] = useState(VISIBLE_ISSUES_STEP);

  const quota = data?.quota ?? null;
  // 物差しが無いのに「枠換算」を選べると、押しても何も変わらない。
  const effectiveUnit: SessionUsageUnit = quota ? unit : "usd";

  const totals = data?.totals;
  const perDayUsd = totals && days > 0 ? totals.costUsd / days : 0;
  const perResponseUsd = totals && totals.responses > 0 ? totals.costUsd / totals.responses : 0;
  const avgContext =
    totals && totals.responses > 0 ? Math.round(totals.contextTokens / totals.responses) : 0;
  const implementation = data?.byKind.find((kind) => kind.key === "implementation");
  const planReview = data?.byKind.find((kind) => kind.key === "plan-review");
  const todayKey = data?.byDay.at(-1)?.date ?? "";
  const issues = data?.byIssue ?? [];

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">AI使用量</h2>
          <p className="text-[11px] text-muted-foreground">
            {/* **いつの報告かを見出しに出す。** 材料はpollerが5分おきに押し込む記録で、
                開いた瞬間の値ではない（古いまま止まっていることに気付けるようにする） */}
            サブPCの{agent === "claude" ? "Claude" : "Codex"}セッションが使ったトークン
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

      <Segmented
        ariaLabel="表示するエージェント"
        options={[
          { value: "claude" as const, label: "Claude" },
          { value: "codex" as const, label: "Codex" },
        ]}
        value={agent}
        onChange={onChangeAgent}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* プラン枠そのもの。**逆算した「枠%」ではなく実測のメーター**で、両方を並べて置く */}
      <section className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold">
            {agent === "claude" ? "Claude" : "Codex"} プラン枠
          </span>
          <span className="text-[11px] text-muted-foreground">実測（下の「枠%」の逆算元）</span>
        </div>
        {agent === "claude" ? (
          <ClaudeUsageCard
            data={data?.planUsage && !("host" in data.planUsage) ? data.planUsage : null}
            isLoading={isLoading && !data}
            error={null}
            notConfigured={data?.planNotConfigured ?? false}
          />
        ) : (
          <CodexUsageCard
            data={data?.planUsage && "host" in data.planUsage ? data.planUsage : null}
            isLoading={isLoading && !data}
            error={null}
            notConfigured={data?.planNotConfigured ?? false}
          />
        )}
      </section>

      <p className="rounded-lg border border-dashed p-2 text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">金額はAPI換算の目安です。</span>
        {agent === "claude" ? "Claude" : "Codex"}サブスクの実費ではありません。
        {quota ? (
          <>
            「枠%」は、上の{quota.windowLabel}枠の実測（{Math.round(quota.usedPercent)}%）と
            同じ期間のローカルセッションの消費から逆算した目安です。同じ枠はGitHub Actionsの
            無人実行とissue-deck自身のAPI呼び出しも使うため、実際よりやや大きめに出ます。
          </>
        ) : (
          <>プラン枠を取得できていないため、枠への換算は出していません。</>
        )}
        集計に使うのは各応答のトークン数と作業ディレクトリだけで、やり取りの中身は読み取りません。
      </p>

      {isLoading && !data && <p className="text-xs text-muted-foreground">読み込み中...</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label={effectiveUnit === "quota" ? "枠換算" : "API換算"}
              value={formatUsageAmount(data.totals.costUsd, effectiveUnit, quota)}
              sub={`1日あたり ${formatUsageAmount(perDayUsd, effectiveUnit, quota)}`}
            />
            <Tile
              label="応答"
              value={data.totals.responses.toLocaleString()}
              sub={`1応答 ${formatUsageUsd(perResponseUsd)}`}
            />
            <Tile
              label="コンテキスト"
              value={formatUsageTokens(data.totals.contextTokens)}
              sub={`平均 ${formatUsageTokens(avgContext)} / 応答`}
            />
            <Tile
              label="セッション"
              value={data.totals.sessions.toLocaleString()}
              sub={`実装 ${implementation?.sessions ?? 0}・計画レビュー ${planReview?.sessions ?? 0}`}
            />
          </div>

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">日別</span>
              <span className="text-[11px] text-muted-foreground">
                いちばん新しい日は集計中（薄い棒）
              </span>
            </div>
            <DailyChart
              days={data.byDay}
              unit={effectiveUnit}
              quota={quota}
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
              }))}
              unit={effectiveUnit}
              quota={quota}
              colorOf={(key) => getRepoColor(key || "(不明)")}
            />
            <Breakdown
              title="種別別"
              hint="作業ディレクトリで判定"
              rows={data.byKind.map((row) => ({
                key: row.key,
                label: sessionUsageKindLabel(row.key),
                sessions: row.sessions,
                costUsd: row.costUsd,
              }))}
              unit={effectiveUnit}
              quota={quota}
            />
          </div>

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">Issue・セッション別</span>
              <span className="text-[11px] text-muted-foreground">
                金額順・押すとセッションごとに開く
              </span>
            </div>
            {issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                記録がありません。サブPCのpollerが報告すると出ます。
              </p>
            ) : (
              <>
                <ul className="flex flex-col">
                  {issues.slice(0, visibleIssues).map((issue) => (
                    <IssueRow
                      key={`${issue.repository ?? ""}#${issue.issueNumber ?? ""}`}
                      issue={issue}
                      unit={effectiveUnit}
                      quota={quota}
                      compact={compact}
                      onOpenIssue={onOpenIssue}
                    />
                  ))}
                </ul>
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
                    {formatUsageAmount(data.omittedIssueCostUsd, effectiveUnit, quota)}
                    ）は明細に出していません。上の合計・内訳には入っています。
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
