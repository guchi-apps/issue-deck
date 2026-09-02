"use client";

import { type ReactNode, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";

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
  formatUsageTokens,
  formatUsageUsd,
  sessionUsageCostSplit,
  sessionUsageKindLabel,
  sessionUsageModelLabel,
  sessionUsagePhaseSplit,
  type SessionUsageEntry,
  type UsageByAgent,
  type UsageBySource,
  type UsageGroup,
  type UsageIssue,
  type UsagePhaseKey,
  type UsagePhaseTotals,
  type UsageTotals,
} from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

/**
 * 「AI使用量」画面（#2504）。**サブPCのローカルセッションが使ったトークン**を、合計 → 推移 →
 * 内訳（リポジトリ別・セッション種別別・アプリ内AI機能別）→ 明細（セッション別）の順に出す。
 *
 * **「アプリ内AI機能別」（issue-deck本体のAI機能が使ったAPIの内訳）は内訳の3枚目**で、
 * セッション種別別の真下に並ぶ（#2631で設定の「状態」から移設し、#2752で画面のいちばん下から
 * ここへ移した）。`claudeApiUsage`を渡したときだけ出る。**期間はこの画面のセレクタ1つに従い**、
 * カード自前の切り替えは持たない（同じ画面に期間の指定が2つあると読み違える）。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`preview-panel.tsx`と同じ切り分け）。
 * 片方にしか置かないと、外出先で「今どこにいくら使っているか」が分からない元の状態がそちらに
 * 残る。
 *
 * **金額は常にAPI換算のドルで出す。** サブスクの実費ではなく目安であることを画面の断り書きで
 * 言う。プラン枠への逆算換算（枠%）は精度が低く、実測のプラン枠メーターと並べる利点が薄いため
 * 廃止した（#2666）。
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

type SessionUsagePanelProps = {
  data: SessionUsageResponse | null;
  isLoading: boolean;
  error: string | null;
  days: number;
  onChangeDays: (days: number) => void;
  onRefresh: () => void;
  /**
   * IssueまたはPRを開く。リポジトリ名（ownerを除く）と、Issue番号・PR番号を渡す
   * （#2650。issueNumberがあればそちらを優先し、無ければprNumberでPRを開く。両方nullでは呼ばれない）。
   * 渡さなければ行を押せない（試験・スマホの一部経路）。
   */
  onOpenIssue?: (repository: string, issueNumber: number | null, prNumber: number | null) => void;
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

/** 期間の切り替えに使う小さなセグメント */
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

/**
 * 金額の棒の内側（#2633・#2667）。**表しているのは「誰が使ったか」で、トークンの帯とは軸が違う。**
 * 日別・内訳の行は太い棒（金額）と細い帯（トークン）の二段で描き、凡例もその2つに分けて出す。
 *
 * **`TOKEN_COLORS`・`OUTPUT_COLOR`（橙・青・紫）とは別の色相に離す**（#2667）。以前はこの3色を
 * そのまま使っており、Claudeと入力トークンが同じ橙、Codexと出力トークンが同じ青、
 * GitHub Actionsと Actionsの入力トークンが同じ紫で完全に一致していた。色覚多様性
 * シミュレーション（protanopia/deuteranopia）と通常視認の両方で、`TOKEN_COLORS`・`OUTPUT_COLOR`・
 * `PHASE_COLORS`のどの色とも離れることを確認して選んでいる（datavizスキルの
 * `validate_palette.js`で検証。IssueAgentBadge（#2635）のindigo/emeraldは`OUTPUT_COLOR`・
 * `TOKEN_COLORS["github-actions"]`と近すぎて転用できなかった）。
 */
const AGENT_COLORS = { claude: "#9f1239", codex: "#33cc4d", actions: "#86198f" } as const;

/**
 * 計画（Plan mode）／実装の内訳の色（#2646）。**誰が使ったか（`AGENT_COLORS`）とは別軸**なので、
 * 既存のオレンジ／青を再利用せず、計画だけ目立たせるティール1色＋残りは中立色にする。
 */
const PHASE_COLORS = { plan: "#0d9488", implementation: "#a8a29e" } as const;

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

/**
 * 画面上部の凡例。**太い棒（金額）と細い帯（トークン）で2段に分ける**（#2633）。
 * 同じ橙・青が「Claude／Codex」と「入力／出力」の両方に出るため、色を並べる前に
 * どちらの棒の話なのかを言う。単価の倍率は「なぜ薄いのか」を色だけに背負わせないため。
 */
function TokenLegend() {
  const groups: {
    lead: string;
    /** 見出しに添える棒の形。太い棒か細い帯かを色より先に示す */
    glyph: "thick" | "thin";
    items: { color: string; label: string; rate?: string }[];
    tail?: string;
  }[] = [
    {
      lead: "太い棒＝金額",
      glyph: "thick",
      items: [
        { color: AGENT_COLORS.claude, label: "Claude" },
        { color: AGENT_COLORS.codex, label: "Codex" },
        { color: AGENT_COLORS.actions, label: "GitHub Actions" },
      ],
      tail: "長さは同じ表の最大との比較",
    },
    {
      lead: "細い帯＝トークン",
      glyph: "thin",
      items: [
        { color: TOKEN_COLORS.local.input, label: "入力", rate: "1.0倍" },
        { color: TOKEN_COLORS.local.cacheCreate, label: "キャッシュ書込", rate: "1.25〜2倍" },
        { color: TOKEN_COLORS.local.cacheRead, label: "キャッシュ読出", rate: "0.1倍" },
        { color: OUTPUT_COLOR, label: "出力" },
        { color: TOKEN_COLORS["github-actions"].input, label: "GitHub Actionsの入力" },
      ],
    },
  ];
  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {groups.map((group) => (
        <div key={group.lead} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-foreground">
            <i
              aria-hidden
              className={cn(
                "mr-1.5 inline-block rounded-full bg-muted-foreground align-middle",
                group.glyph === "thick" ? "h-2 w-3.5" : "h-1 w-3.5",
              )}
            />
            {group.lead}
          </span>
          {group.items.map((item) => (
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
          {group.tail ? <span>{group.tail}</span> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 合計行（日別・リポジトリ別・種別別）のトークン内訳。**ローカルの濃さの並びだけで塗る。**
 * この行はGitHub Actionsぶんも足し込んだ合計で、実行経路別に色を変えると1本の帯へ
 * 「区分」と「実行経路」の2つの軸が混ざる（それを避けるのが#2633）。
 */
function groupTokenSegments(totals: UsageTotals): TokenSegment[] {
  return [
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
    { key: "output", label: "出力", value: totals.outputTokens, color: OUTPUT_COLOR },
  ];
}

/**
 * 金額の棒の内側の割合（#2633）。**GitHub ActionsはClaude Codeなので`byAgent.claude`にも
 * 入っている**（`session-usage-view.ts`が`agent`と`source`の両方へ同じ行を足す）。
 * 引かずに使うと、Claudeの帯がActionsのぶんまで伸びたうえで、残りとして描いていたCodexが
 * Actionsのぶんだけ短くなる。
 */
function costSplitByAgent(row: CostRow) {
  const actions = row.bySource["github-actions"].costUsd;
  return {
    claude: Math.max(0, row.byAgent.claude.costUsd - actions),
    codex: row.byAgent.codex.costUsd,
    actions,
  };
}

type CostRow = { costUsd: number; byAgent: UsageByAgent; bySource: UsageBySource };

/**
 * 日別・内訳の太い棒。長さが金額、内側がClaude／Codex／GitHub Actionsの割合。
 * **割合そのものは棒に数値を書けないので、ツールチップへ金額で出す。**
 */
function CostBar({
  row,
  widthPercent,
  highlighted,
}: {
  row: CostRow;
  widthPercent: number;
  /** いちばん新しい日（集計途中）だけ枠線を足す */
  highlighted?: boolean;
}) {
  const split = costSplitByAgent(row);
  const toPercent = (value: number) => (row.costUsd > 0 ? (value / row.costUsd) * 100 : 0);
  const parts = [
    { key: "claude", label: "Claude", value: split.claude, color: AGENT_COLORS.claude },
    { key: "codex", label: "Codex", value: split.codex, color: AGENT_COLORS.codex },
    { key: "actions", label: "GitHub Actions", value: split.actions, color: AGENT_COLORS.actions },
  ];
  return (
    <div
      className={cn(
        "h-2.5 overflow-hidden rounded-full bg-muted",
        highlighted && "ring-1 ring-muted-foreground/40",
      )}
      title={parts
        .map((part) => `${part.label} ${formatUsageUsd(part.value)}`)
        .join(" / ")}
    >
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${widthPercent}%` }}>
        {parts.map((part) => (
          <span
            key={part.key}
            style={{ width: `${toPercent(part.value)}%`, backgroundColor: part.color }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 太い棒の下に置く細い帯（#2633）。**長さもトークン量に比例させる**——比率だけの帯にすると
 * どの行も同じ長さになり、金額の棒とのズレ（キャッシュ読出に寄った「量は多いが安い」行）が
 * 消えてしまう。
 */
function GroupTokenBar({ totals, maxTokens }: { totals: UsageTotals; maxTokens: number }) {
  const segments = groupTokenSegments(totals);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-muted"
      title={segments.map((segment) => `${segment.label} ${formatUsageTokens(segment.value)}`).join(" / ")}
    >
      <div
        className="flex h-full overflow-hidden rounded-full"
        style={{ width: `${maxTokens > 0 ? (total / maxTokens) * 100 : 0}%` }}
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
    </div>
  );
}

/** 合計タイルに挟む、期間全体のコンテキストの内訳。入力側の3つだけを見せる */
function ContextBar({ totals }: { totals: UsageTotals }) {
  const segments = groupTokenSegments(totals).slice(0, 3);
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
 * 日別の棒。**1行に太い棒（金額）と細い帯（トークン）を積む**（#2633）。金額とトークンは
 * 比例しない——キャッシュ読出に寄った日は帯が長いのに棒が短く出る——ので、1本へ混ぜずに
 * 軸ごとに分ける。**いちばん新しい日だけ枠線を足す**（集計の途中で必ず低く出るため、同じ塗りだと
 * 「減った」と読めてしまう）。ライブラリを足さずCSSだけで描く。
 */
function DailyChart({
  days,
  todayKey,
}: {
  days: SessionUsageResponse["byDay"];
  todayKey: string;
}) {
  const max = days.reduce((peak, day) => Math.max(peak, day.costUsd), 0);
  const maxTokens = days.reduce(
    (peak, day) => Math.max(peak, day.contextTokens + day.outputTokens),
    0,
  );
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {days.map((day) => {
        const totalTokens = day.contextTokens + day.outputTokens;
        return (
          <div
            key={day.date}
            className="grid grid-cols-[3.5rem_1fr_4rem] items-center gap-2 text-[10px]"
            title={`${day.date}　${formatUsageUsd(day.costUsd)}　${day.responses.toLocaleString()}応答　${formatUsageTokens(totalTokens)}`}
          >
            <span className="text-muted-foreground tabular-nums">
              {formatMonthDay(`${day.date}T00:00:00+09:00`)}
            </span>
            <div className="flex flex-col gap-0.5">
              <CostBar
                row={day}
                widthPercent={max > 0 ? (day.costUsd / max) * 100 : 0}
                highlighted={day.date === todayKey}
              />
              <GroupTokenBar totals={day} maxTokens={maxTokens} />
            </div>
            <span className="text-right font-semibold tabular-nums">
              {formatUsageUsd(day.costUsd)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * リポジトリ別・種別別の内訳。日別と同じ二段（太い棒＝金額・細い帯＝トークン）で描く（#2633）。
 * **太い棒の内側も日別と同じ3分割**（Claude／Codex／GitHub Actions）にする。ここだけ
 * 「Claude／それ以外」の2分割だったため、同じ画面の同じ色が行によって別の意味になっていた。
 */
function Breakdown({
  title,
  hint,
  rows,
  colorOf,
  maxVisibleRows,
}: {
  title: string;
  hint: string;
  rows: (UsageGroup & { label: string })[];
  colorOf?: (key: string) => string | undefined;
  maxVisibleRows?: number;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const max = rows[0]?.costUsd ?? 0;
  const maxTokens = rows.reduce(
    (peak, row) => Math.max(peak, row.contextTokens + row.outputTokens),
    0,
  );
  const visibleRows =
    maxVisibleRows !== undefined && !isExpanded ? rows.slice(0, maxVisibleRows) : rows;
  const hiddenRows = maxVisibleRows !== undefined ? Math.max(rows.length - maxVisibleRows, 0) : 0;

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        {/* **見出しは折り返さない**（#2752）。スマホ幅では見出しと補足が2行ずつに割れて
            カードの上半分が文字で埋まっていた。あふれたときに省略記号へ落ちるのは補足だけ */}
        <span className="shrink-0 text-xs font-semibold whitespace-nowrap">{title}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground tabular-nums">
          {hint}
        </span>
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
                    {formatUsageUsd(row.costUsd)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <CostBar
                    row={row}
                    widthPercent={max > 0 ? (row.costUsd / max) * 100 : 0}
                  />
                  <GroupTokenBar totals={row} maxTokens={maxTokens} />
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

/**
 * 料金の下に添える計画/実装の内訳（#2646）。`sessionUsagePhaseSplit`が値を返すセッション
 * （Plan modeを使った実装セッション）だけ出す。**常にドル表示**——`内訳`列の入力/出力と同じく、
 * 枠%のときも金額のまま出す（按分し直さないため）。
 */
function PhaseSplitNote({ entry }: { entry: SessionUsageEntry }) {
  const split = sessionUsagePhaseSplit(entry);
  if (!split) return null;
  const total = split.planCostUsd + split.implementationCostUsd;
  const planPercent = total > 0 ? (split.planCostUsd / total) * 100 : 0;
  return (
    <div className="mt-1">
      <div className="flex h-1 overflow-hidden rounded-full bg-muted">
        <span className="min-w-[2px]" style={{ width: `${planPercent}%`, backgroundColor: PHASE_COLORS.plan }} />
        <span
          className="min-w-[2px]"
          style={{ width: `${100 - planPercent}%`, backgroundColor: PHASE_COLORS.implementation }}
        />
      </div>
      <p className="mt-0.5 text-[9px] font-normal whitespace-nowrap text-muted-foreground">
        計画 {formatUsageUsd(split.planCostUsd)}・実装 {formatUsageUsd(split.implementationCostUsd)}
      </p>
    </div>
  );
}

type SessionRow = { issue: UsageIssue; entry: SessionUsageEntry };

/** issueNumberがあればIssue表示、無くprNumberがあればPR表示。両方無ければ未特定（#2650） */
function issueGroupLabel(issue: Pick<UsageIssue, "issueNumber" | "prNumber">): string {
  if (issue.issueNumber !== null) return `#${issue.issueNumber}`;
  if (issue.prNumber !== null) return `PR #${issue.prNumber}`;
  return "（Issue未特定）";
}

/** Issue・PRのグループを一意に識別するキー。表示の開閉状態を保持するのに使う（#2653） */
function issueGroupKey(issue: Pick<UsageIssue, "repository" | "issueNumber" | "prNumber">): string {
  return `${issue.repository ?? ""}#${issue.issueNumber ?? ""}#${issue.prNumber ?? ""}`;
}

/**
 * セッション名（種別・エージェント・モデル）と、Actionsの実行を開く導線。
 * **Issue番号・リポジトリの表示は`hideIssueLabel`で消せる**（#2653）。展開したIssueグループの
 * 中では見出しに同じラベル・導線がすでに出ているため、セッションごとに繰り返さない。
 */
function SessionName({
  issue,
  entry,
  onOpenIssue,
  hideIssueLabel = false,
}: SessionRow & {
  onOpenIssue?: (repository: string, issueNumber: number | null, prNumber: number | null) => void;
  hideIssueLabel?: boolean;
}) {
  const repository = issue.repository ?? "(不明)";
  const canOpen = Boolean(onOpenIssue && issue.repository && (issue.issueNumber || issue.prNumber));
  const label = issueGroupLabel(issue);
  return (
    <div className="flex items-start gap-1.5">
      {!hideIssueLabel && (
        <span aria-hidden className="mt-1 size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: getRepoColor(repository) }} />
      )}
      <div className="min-w-0 flex-1">
        {!hideIssueLabel && (
          <div className="truncate font-semibold text-foreground">
            {label} {repository}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="truncate">
            {entry.source === "github-actions" ? "GitHub Actions" : sessionUsageKindLabel(entry.kind)} ・{" "}
            {entry.agent === "claude" ? "Claude" : "Codex"}
            {entry.workflowName ? ` ・ ${entry.workflowName}` : ""}
          </span>
          {/* 使ったモデル（#2646）。集計側は`models`を持っているが、これまで画面に出していなかった */}
          {entry.models.map((model) => (
            <span
              key={model}
              className="shrink-0 rounded border bg-muted px-1 py-px text-[9px] font-medium text-foreground"
            >
              {sessionUsageModelLabel(model)}
            </span>
          ))}
        </div>
      </div>
      {!hideIssueLabel && canOpen && (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0"
          title={issue.issueNumber !== null ? "Issueを開く" : "PRを開く"}
          onClick={() => onOpenIssue?.(issue.repository as string, issue.issueNumber, issue.prNumber)}
        >
          <ExternalLink className="size-3" />
          <span className="sr-only">{issue.issueNumber !== null ? "Issueを開く" : "PRを開く"}</span>
        </Button>
      )}
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
  onOpenIssue,
  hideIssueLabel = false,
}: {
  sessions: SessionRow[];
  maxTokens: number;
  onOpenIssue?: (repository: string, issueNumber: number | null, prNumber: number | null) => void;
  hideIssueLabel?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map(({ issue, entry }) => {
        const segments = tokenSegments(entry);
        const totalTokens = entry.contextTokens + entry.outputTokens;
        const totalWidth = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
        // 内訳は集計側が単価から割ったものを使う（#2626）。持っていない行だけ近似になる。
        const costSplit = sessionUsageCostSplit(entry);
        return (
          <li
            key={`${entry.host}:${entry.sessionId}`}
            className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-[11px]"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <SessionName issue={issue} entry={entry} onOpenIssue={onOpenIssue} hideIssueLabel={hideIssueLabel} />
              </div>
              <div className="shrink-0 text-right">
                <span className="font-semibold tabular-nums">
                  {formatUsageUsd(entry.costUsd)}
                </span>
                <PhaseSplitNote entry={entry} />
              </div>
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
            <div
              className="text-[10px] tabular-nums text-muted-foreground"
              title={
                costSplit.approximate
                  ? "このセッションは金額の内訳を記録していないため、トークン数の比で按分した概算です（キャッシュの単価差を反映できていません）"
                  : undefined
              }
            >
              入力 {costSplit.approximate ? "約" : ""}
              {formatUsageUsd(costSplit.inputCostUsd)}・出力 {costSplit.approximate ? "約" : ""}
              {formatUsageUsd(costSplit.outputCostUsd)}
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

/**
 * Issue（またはIssue未特定のPR）1件ぶんの行（#2653）。**同じIssue番号を持つセッションは、
 * そこから派生したPRのGitHub Actions実行も含めて`issue`に合算済み**（`session-usage-view.ts`の
 * `buildSessionUsageSummary`）。ここでは合算した1本の横棒グラフとして出し、クリックで
 * 中の各セッションを展開する。`Breakdown`の行（リポジトリ別・種別別）と同じ描き方に揃える。
 */
const PHASE_META: Record<UsagePhaseKey, { label: string; dotColor: string }> = {
  plan: { label: "計画", dotColor: PHASE_COLORS.plan },
  implementation: { label: "実装", dotColor: PHASE_COLORS.implementation },
  action: { label: "Action", dotColor: AGENT_COLORS.actions },
};

const PHASE_ORDER: UsagePhaseKey[] = ["plan", "implementation", "action"];

/**
 * 1フェーズぶんのトークンバー（#2670）。**Actionだけ実測なので、既存の4色積み上げ
 * （入力／キャッシュ書込／キャッシュ読出／出力）を出せる。** 計画・実装は金額比で按分した
 * 概算（`buildPhaseBreakdown`）で、入力/出力の構成比までは分からないため、単色1本に留める
 * ——4色に分けると、按分では出せないはずの精度があるように見えてしまう。
 */
function PhaseTokenBar({
  phaseKey,
  totals,
  widthPercent,
}: {
  phaseKey: UsagePhaseKey;
  totals: UsagePhaseTotals;
  widthPercent: number;
}) {
  if (phaseKey === "action") {
    const segments: TokenSegment[] = [
      { key: "input", label: "入力", value: totals.inputTokens, color: TOKEN_COLORS["github-actions"].input },
      {
        key: "cacheCreate",
        label: "書込",
        value: totals.cacheCreateTokens,
        color: TOKEN_COLORS["github-actions"].cacheCreate,
      },
      {
        key: "cacheRead",
        label: "読出",
        value: totals.cacheReadTokens,
        color: TOKEN_COLORS["github-actions"].cacheRead,
      },
      { key: "output", label: "出力", value: totals.outputTokens, color: OUTPUT_COLOR },
    ];
    return <TokenBar segments={segments} widthPercent={widthPercent} />;
  }
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full opacity-70"
        style={{ width: `${widthPercent}%`, backgroundColor: PHASE_META[phaseKey].dotColor }}
      />
    </div>
  );
}

/**
 * Issue1件ぶんの「計画・実装・Action」サマリー（#2670）。**実績が無いフェーズは行ごと出さない**
 * （$0や0件を表示しない）。展開したセッション明細（`SessionCards`）の上に置く、Issue全体を
 * 3分類へロールアップした集計行。
 */
function PhaseBreakdownRows({ phases }: { phases: UsageIssue["phases"] }) {
  const rows = PHASE_ORDER.map((key) => ({ key, totals: phases[key] })).filter(
    ({ totals }) => totals.sessions > 0,
  );
  if (rows.length === 0) return null;

  const maxTokens = rows.reduce(
    (max, { totals }) => Math.max(max, totals.contextTokens + totals.outputTokens),
    0,
  );

  return (
    <div className="mb-1.5 flex flex-col gap-1.5 border-b pb-2">
      {rows.map(({ key, totals }) => {
        const totalTokens = totals.contextTokens + totals.outputTokens;
        const widthPercent = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
        const meta = PHASE_META[key];
        return (
          <div key={key} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1 font-semibold">
              <i aria-hidden className="size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: meta.dotColor }} />
              {meta.label}
            </span>
            <div className="min-w-0">
              <PhaseTokenBar phaseKey={key} totals={totals} widthPercent={widthPercent} />
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
                <span className="truncate">
                  {formatUsageTokens(totalTokens)} トークン
                  {key === "action" ? `・${totals.sessions}実行` : ""}
                </span>
                {totals.models.length > 0 && (
                  <span className="hidden shrink-0 truncate rounded border bg-muted px-1 py-px text-[9px] font-medium sm:inline">
                    {totals.models.map(sessionUsageModelLabel).join("・")}
                  </span>
                )}
              </div>
            </div>
            <span className="text-right font-semibold tabular-nums">{formatUsageUsd(totals.costUsd)}</span>
          </div>
        );
      })}
    </div>
  );
}

function IssueGroupRow({
  issue,
  maxCost,
  maxTokens,
  isOpen,
  onToggle,
  onOpenIssue,
}: {
  issue: UsageIssue;
  maxCost: number;
  maxTokens: number;
  isOpen: boolean;
  onToggle: () => void;
  onOpenIssue?: (repository: string, issueNumber: number | null, prNumber: number | null) => void;
}) {
  const repository = issue.repository ?? "(不明)";
  const canOpen = Boolean(onOpenIssue && issue.repository && (issue.issueNumber || issue.prNumber));
  const sessions: SessionRow[] = issue.entries.map((entry) => ({ issue, entry }));
  const sessionMaxTokens = sessions.reduce(
    (max, { entry }) => Math.max(max, entry.contextTokens + entry.outputTokens),
    0,
  );

  return (
    <li className={cn("rounded-lg", isOpen && "bg-muted/40")}>
      <div className="flex items-start gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-accent"
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          <ChevronRight
            aria-hidden
            className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
          />
          <span aria-hidden className="mt-1.5 size-[7px] shrink-0 rounded-[2px]" style={{ backgroundColor: getRepoColor(repository) }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <span className="shrink-0 font-semibold text-foreground">{issueGroupLabel(issue)}</span>
              <span className="min-w-0 truncate text-muted-foreground">{repository}</span>
              <span className="ml-auto shrink-0 pl-2 text-muted-foreground tabular-nums">
                {issue.sessions}セッション
              </span>
            </div>
            {/* Issue・PRのタイトル（#2686）。取得できなかった行は出さず番号のみのままにする */}
            {issue.title && (
              <p className="mt-0.5 truncate text-[11px] text-foreground" title={issue.title}>
                {issue.title}
              </p>
            )}
            <div className="mt-1 flex flex-col gap-0.5">
              <CostBar row={issue} widthPercent={maxCost > 0 ? (issue.costUsd / maxCost) * 100 : 0} />
              <GroupTokenBar totals={issue} maxTokens={maxTokens} />
            </div>
          </div>
        </button>
        <span className="shrink-0 px-1.5 pt-2.5 text-right text-xs font-semibold tabular-nums">
          {formatUsageUsd(issue.costUsd)}
        </span>
        {/* 開けない行（Issue番号もPR番号も無い「Issue未特定」）でも同じ寸法で描き、
            見た目とキーボード操作だけを消す（#2685）。**条件付きでDOMごと消すと**、
            隣の`flex-1`ボタン（棒グラフを含む）がそのぶん右へ広がり、棒グラフのレールだけ
            他の行より右に長く見えてしまう。 */}
        <Button
          variant="ghost"
          size="icon"
          disabled={!canOpen}
          aria-hidden={!canOpen}
          className={cn("mt-1 size-5 shrink-0", !canOpen && "invisible")}
          title={issue.issueNumber !== null ? "Issueを開く" : "PRを開く"}
          onClick={() => onOpenIssue?.(issue.repository as string, issue.issueNumber, issue.prNumber)}
        >
          <ExternalLink className="size-3" />
          <span className="sr-only">{issue.issueNumber !== null ? "Issueを開く" : "PRを開く"}</span>
        </Button>
      </div>
      {isOpen && (
        <div className="py-1 pr-1 pl-8">
          <PhaseBreakdownRows phases={issue.phases} />
          <SessionCards
            sessions={sessions}
            maxTokens={sessionMaxTokens}
            onOpenIssue={onOpenIssue}
            hideIssueLabel
          />
        </div>
      )}
    </li>
  );
}

/**
 * Issue・PR別の一覧。**横棒グラフが縦に複数並ぶ**（#2653）。PC・スマホで同じ土台を使う
 * ——以前はデスクトップだけ表（`<table>`）だったが、Issue単位で合算した行を並べる今の形は
 * どちらの幅でも同じ見え方でよく、分ける理由が無くなった。
 */
function IssueGroupList({
  issues,
  openKeys,
  onToggle,
  onOpenIssue,
}: {
  issues: UsageIssue[];
  openKeys: Record<string, boolean>;
  /** 押された行の直前の開閉状態（既定値込み）を渡す。呼び出し側はこれを反転させるだけでよい */
  onToggle: (key: string, wasOpen: boolean) => void;
  onOpenIssue?: (repository: string, issueNumber: number | null, prNumber: number | null) => void;
}) {
  if (issues.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  const maxCost = issues.reduce((peak, issue) => Math.max(peak, issue.costUsd), 0);
  const maxTokens = issues.reduce(
    (peak, issue) => Math.max(peak, issue.contextTokens + issue.outputTokens),
    0,
  );

  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, index) => {
        const key = issueGroupKey(issue);
        // 既定では一番新しい活動のIssueだけ開く。それ以外はユーザーが押した分だけ開閉する（#2653）。
        const isOpen = openKeys[key] ?? index === 0;
        return (
          <IssueGroupRow
            key={key}
            issue={issue}
            maxCost={maxCost}
            maxTokens={maxTokens}
            isOpen={isOpen}
            onToggle={() => onToggle(key, isOpen)}
            onOpenIssue={onOpenIssue}
          />
        );
      })}
    </ul>
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
  const [visibleIssues, setVisibleIssues] = useState(VISIBLE_ISSUES_STEP);
  // Issue・PRの行ごとの開閉状態。キーが無ければ既定（一番新しい行だけ開く）に従う（#2653）。
  const [openIssueKeys, setOpenIssueKeys] = useState<Record<string, boolean>>({});

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

  /**
   * issue-deck本体のAI機能が使ったAPIの内訳（#2347・#2631で設定の「状態」から移設）。
   * **置き場が2つある**（#2752）。ふだんはセッション種別別の真下だが、セッションの記録が
   * まだ1件も無いときは上の内訳ごと描かれないため、単独でここへ出す。
   */
  const apiUsageSection = claudeApiUsage ? (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-semibold whitespace-nowrap">アプリ内AI機能別</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          Issueの要約・AI検索など
        </span>
      </div>
      <ClaudeApiUsageList
        data={claudeApiUsage.data}
        isLoading={claudeApiUsage.isLoading}
        error={claudeApiUsage.error}
        days={days}
      />
    </section>
  ) : null;

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

      {/* プラン枠そのもの。**実測のメーター**で、Claude・Codexを並べて置く */}
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label="従量課金相当"
              value={formatUsageUsd(data.totalsByAgent.claude.costUsd + data.totalsByAgent.codex.costUsd)}
              sub={agentCostSub}
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

          <TokenLegend />

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">日別</span>
              {/* 太い棒＝金額／細い帯＝トークンの説明は直上のTokenLegendと重複するため落とす
                  （#2666）。枠線の意味（集計途中で必ず低く出る）はここにしか無いので残す */}
              <span className="text-[11px] text-muted-foreground">
                いちばん新しい日は集計中
              </span>
            </div>
            <DailyChart
              days={data.byDay}
              todayKey={todayKey}
            />
          </section>

          <div
            className={cn("grid items-start gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}
          >
            <Breakdown
              title="リポジトリ別"
              hint={`${data.byRepository.length}リポジトリ`}
              rows={data.byRepository.map((row) => ({ ...row, label: row.key || "(不明)" }))}
              colorOf={(key) => getRepoColor(key || "(不明)")}
              maxVisibleRows={5}
            />
            {/* **アプリ内AI機能別はセッション種別別の真下に置く**（#2752）。同じ「何にAIを
                使ったか」の内訳なのに、以前は明細を挟んだ画面のいちばん下に離れていた */}
            <div className="flex flex-col gap-2">
              <Breakdown
                title="セッション種別別"
                hint="作業ディレクトリで判定"
                rows={data.byKind.map((row) => ({ ...row, label: sessionUsageKindLabel(row.key) }))}
              />
              {apiUsageSection}
            </div>
          </div>

          <section className="flex flex-col gap-1 rounded-lg border p-3">
            <span className="text-xs font-semibold">Issue・PR別</span>
            {issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                記録がありません。サブPCまたはGitHub Actionsから報告されると出ます。
              </p>
            ) : (
              <>
                <IssueGroupList
                  issues={issues.slice(0, visibleIssues)}
                  openKeys={openIssueKeys}
                  onToggle={(key, wasOpen) =>
                    setOpenIssueKeys((prev) => ({ ...prev, [key]: !wasOpen }))
                  }
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

      {/* **セッションの記録がまだ届いていないときの置き場**（#2752）。届いていれば上の
          内訳（セッション種別別の下）へ出る。このアプリ自身の消費はセッションと無関係に
          数えられているので、`data`が無くても出せる状態を保つ */}
      {!data && apiUsageSection}
    </div>
  );
}
