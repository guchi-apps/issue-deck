"use client";

import { Fragment, memo, type CSSProperties, type ReactNode, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { CodexUsageCard } from "@/components/dashboard/codex-usage-card";
import { RepositoryPieChart } from "@/components/dashboard/repository-pie-chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionUsagePlan, SessionUsagePlanState, SessionUsageResponse } from "@/hooks/use-session-usage";
import { useNow } from "@/hooks/use-now";
import { formatDateTime, formatMonthDay, formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { AGENT_BASE_COLORS, AGENT_MODEL_TIER_COLORS } from "@/lib/agent-model-color";
import { getRepoColor } from "@/lib/repo-color";
import {
  buildRepositoryPieSlices,
  fillUsageDays,
  formatSessionElapsed,
  formatUsageTokens,
  formatUsageUsd,
  isUsageKindInWorkFlow,
  niceAxisScale,
  sessionUsageCostSplit,
  sessionUsageKindLabel,
  sessionUsageModelLabel,
  sessionUsagePhaseSplit,
  usagePhaseKindKey,
  IMPLEMENTATION_UNSPLIT_KIND_KEY,
  REPOSITORY_PIE_TOP_COUNT,
  type CurrentSessionTone,
  type CurrentSessionUsage,
  type SessionUsageEntry,
  type UsageByAgent,
  type UsageBySource,
  type UsageGroup,
  type UsageIssue,
  type UsageTotals,
} from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

/**
 * 「AI使用量」画面（#2504）。**サブPCのローカルセッションが使ったトークン**を、合計 → 推移 →
 * 内訳（リポジトリ別・セッション種別別）→ 明細（セッション別）の順に出す。
 *
 * **issue-deck本体のAI機能が使ったAPIの内訳（旧「アプリ内AI機能別」）はここに出さない**
 * （#3062で削除）。この画面はサブPCのセッションの使用量だけを扱う。
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
  /** プラン枠（#3304）。集計より遅れて届くので別に受け取る。届くまではメーターの形で待つ */
  plan: SessionUsagePlanState;
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
  /** スマホ向けに縮める。表をカードへ畳み、入力トークン列を落とす */
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
  /** 値と`sub`のあいだに挟む細い帯（入力トークンの内訳）。無ければ出さない */
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
 * Issue・PR別の行は太い棒（金額）と細い帯（トークン）の二段で描き、凡例もその2つに分けて出す
 * （日別は#3038で縦棒、リポジトリ別は#3060で円グラフに変わり、種別別は#3064で金額の棒だけにした）。
 *
 * **`TOKEN_COLORS`・`OUTPUT_COLOR`（橙・青・紫）とは別の色相に離す**（#2667）。以前はこの3色を
 * そのまま使っており、Claudeと入力トークンが同じ橙、Codexと出力トークンが同じ青、
 * GitHub Actionsと Actionsの入力トークンが同じ紫で完全に一致していた。色覚多様性
 * シミュレーション（protanopia/deuteranopia）と通常視認の両方で、`TOKEN_COLORS`・`OUTPUT_COLOR`・
 * `PHASE_COLORS`のどの色とも離れることを確認して選んでいる（datavizスキルの
 * `validate_palette.js`で検証。IssueAgentBadge（#2635）のindigo/emeraldは`OUTPUT_COLOR`・
 * `TOKEN_COLORS["github-actions"]`と近すぎて転用できなかった）。
 *
 * **Claude・Codexの色は実行状況の●と同じ系統**（#3075。`AGENT_BASE_COLORS`）。以前の
 * rose-800（#9f1239）と明るい緑（#33cc4d）は明度が離れすぎていて、●の濃淡の段を作れなかった。
 * **段が決まらないぶんの色として、進捗バー等ではこの1色に固定したまま使う**（#3396。
 * 日別グラフだけは`dailyChartParts`が`AGENT_MODEL_TIER_COLORS`の濃淡へ差し替える）。
 */
const AGENT_COLORS = { ...AGENT_BASE_COLORS, actions: "#86198f" } as const;

/**
 * 計画（Plan mode）／実装の内訳の色（#2646）。**誰が使ったか（`AGENT_COLORS`）とは別軸**なので、
 * 既存のオレンジ／青を再利用せず、計画だけ目立たせるティール1色＋残りは中立色にする。
 */
const PHASE_COLORS = { plan: "#0d9488", implementation: "#a8a29e" } as const;

/**
 * 「セッション種別別」でフェーズの行に付ける点の色（#2779）。**棒の色分け（誰が使ったか）とは
 * 別の軸**なので、行頭の小さな点だけで示す。計画だけティールで目立たせ、残りは調査 → 実装 →
 * 仕上げの順に薄くなる中立色にして、並びが工程の順序に見えるようにする
 * （`PHASE_COLORS`の考え方をそのまま4段へ伸ばしたもの）。
 */
const KIND_ROW_COLORS: Record<string, string> = {
  [usagePhaseKindKey("plan")]: PHASE_COLORS.plan,
  [usagePhaseKindKey("research")]: "#78716c",
  [usagePhaseKindKey("coding")]: PHASE_COLORS.implementation,
  // 検証は実装と仕上げのあいだの濃さ（#3064）
  [usagePhaseKindKey("verify")]: "#c4b5a5",
  [usagePhaseKindKey("wrapup")]: "#d6d3d1",
  [IMPLEMENTATION_UNSPLIT_KIND_KEY]: "#52525b",
};

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
 * 合計行（Issue・PR別）のトークン内訳。**ローカルの濃さの並びだけで塗る。**
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
 * 日別の縦棒1本ぶんの積み上げ内訳（#3396）。Claude／Codexは`byAgent`の合計ではなく
 * `day.modelTiers`（モデルの重さ別、`session-usage-view.ts`が集計済み）で分け、実行状況の
 * ●と同じ`AGENT_MODEL_TIER_COLORS`の濃淡を使う。段が決まらないぶんは`AGENT_BASE_COLORS`
 * （濃淡なしの代表色）。GitHub Actionsは従来どおり`costSplitByAgent`の単色のまま
 * （モデル情報が薄いため据え置き）。**濃い（重い）ものを下、薄い（軽い）ものを上、
 * Actionsをいちばん上に積む**（呼び出し側が`flex-col-reverse`で描くため、配列の先頭が最下段）。
 */
function dailyChartParts(day: SessionUsageResponse["byDay"][number]) {
  const split = costSplitByAgent(day);
  const tierParts = (["claude", "codex"] as const).flatMap((agent) => {
    const bucket = day.modelTiers[agent];
    return [
      ...([0, 1, 2, 3] as const).map((tier) => ({
        key: `${agent}-tier${tier}`,
        value: bucket.costUsd[tier],
        color: AGENT_MODEL_TIER_COLORS[agent][tier],
      })),
      { key: `${agent}-unresolved`, value: bucket.unresolvedCostUsd, color: AGENT_BASE_COLORS[agent] },
    ];
  });
  // 金額0の区分は積んでも見えないので出さない（DOM要素数を実際の内訳と揃える）。
  return [...tierParts, { key: "actions", value: split.actions, color: AGENT_COLORS.actions }].filter(
    (part) => part.value > 0,
  );
}

/**
 * 内訳の太い棒。長さが金額、内側がClaude／Codex／GitHub Actionsの割合（日別の縦棒も同じ3色）。
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

/** 合計タイルに挟む、期間全体の入力トークンの内訳。入力側の3つだけを見せる */
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

/** 縦軸の目盛りの表記。`$100`・`$2.5`のように、間隔の刻みに合わせて小数を出す */
function formatAxisUsd(value: number): string {
  if (value === 0) return "$0";
  return `$${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)}`;
}

/** 日別の縦軸ラベルを何日おきに出すか。7日までは全日、それより多いと5日おき（最新日から数える） */
const DAILY_LABEL_EVERY_DAYS = 5;
const DAILY_ALL_LABELS_MAX_DAYS = 10;
/** この日数までは棒の上に金額を出す。それを超えると幅が足りないので最大の日だけにする */
const DAILY_VALUE_LABELS_MAX_DAYS = 7;

/**
 * 日別の縦棒グラフ（#3038）。**縦軸が金額、横軸が日付。** 期間の全日を等間隔に並べ、
 * 金額0の日も日付ラベルと基準線上の短い印を残す（棒だけを消すと、隣の日が連続して見える）。
 * 棒の幅は列数で割って決めるので、30日でもスマホで横スクロールしない（日付ラベルは間引く）。
 * 平均は期間の全日（0の日と集計中の最新日を含む）÷日数で、横の点線と「平均 $○○」で示す。
 *
 * **トークン量は使わない**（金額と比例しないための二段の帯は#2633で入れたが、日別では不要になった。
 * Issue・PR別には残っている）。**棒の内側は、Claude／Codexをモデルの重さ（tier）別の濃淡で
 * 分け、GitHub Actionsは単色のまま積む**（#3396。`dailyChartParts`）。最新日は集計の途中で
 * 必ず低く出るので、枠線を足して「減った」と読ませない。ライブラリを足さずCSSだけで描く。
 */
function DailyChart({
  days,
  todayKey,
}: {
  days: SessionUsageResponse["byDay"];
  todayKey: string;
}) {
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">記録がありません</p>;
  }

  const peak = days.reduce((top, day) => Math.max(top, day.costUsd), 0);
  const scale = niceAxisScale(peak);
  const average = days.reduce((sum, day) => sum + day.costUsd, 0) / days.length;
  const peakIndex = days.findIndex((day) => day.costUsd === peak);
  const isFewDays = days.length <= DAILY_VALUE_LABELS_MAX_DAYS;
  const showsEveryLabel = days.length <= DAILY_ALL_LABELS_MAX_DAYS;
  const barsGap = isFewDays ? "gap-2 sm:gap-3" : "gap-[2px] sm:gap-1";
  const barMaxWidth = isFewDays ? "max-w-16" : "max-w-6";

  return (
    <div className="grid grid-cols-[2.4rem_minmax(0,1fr)] gap-x-1 text-[10px] text-muted-foreground tabular-nums sm:grid-cols-[2.9rem_minmax(0,1fr)] sm:gap-x-1.5">
      <div className="relative h-52">
        {scale.ticks.map((tick) => (
          <span
            key={tick}
            className="absolute right-0 translate-y-1/2 leading-none whitespace-nowrap"
            style={{ bottom: `${(tick / scale.max) * 100}%` }}
          >
            {formatAxisUsd(tick)}
          </span>
        ))}
      </div>
      <div className="relative h-52">
        {scale.ticks.map((tick) => (
          <div
            key={tick}
            aria-hidden
            className={cn("absolute inset-x-0 border-t", tick === 0 ? "border-muted-foreground/60" : "border-border")}
            style={{ bottom: `${(tick / scale.max) * 100}%` }}
          />
        ))}
        <div className={cn("absolute inset-0 flex items-end", barsGap)}>
          {days.map((day, index) => {
            const parts = dailyChartParts(day);
            const split = costSplitByAgent(day);
            const isZero = day.costUsd <= 0;
            const showsValue = !isZero && (isFewDays || index === peakIndex);
            const modelNote = day.modelLabels.length > 0 ? `　・　モデル: ${day.modelLabels.join(", ")}` : "";
            const dayTitle =
              `${day.date}　${formatUsageUsd(day.costUsd)}　${day.responses.toLocaleString()}応答　・　` +
              `Claude ${formatUsageUsd(split.claude)} / Codex ${formatUsageUsd(split.codex)} / ` +
              `GitHub Actions ${formatUsageUsd(split.actions)}${modelNote}`;
            return (
              <div
                key={day.date}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center"
                title={dayTitle}
              >
                {isZero ? (
                  // 棒の代わりに基準線上へ短い印を置き、「0だった日」と「日付が抜けた」を区別する
                  <span
                    aria-hidden
                    className={cn("h-0.5 w-full rounded-full bg-muted-foreground/50", barMaxWidth)}
                  />
                ) : (
                  <div
                    className={cn(
                      "flex w-full flex-col-reverse overflow-hidden rounded-t-[2px]",
                      barMaxWidth,
                      day.date === todayKey && "outline outline-1 outline-offset-1 outline-muted-foreground/60",
                    )}
                    style={{ height: `${(day.costUsd / scale.max) * 100}%` }}
                  >
                    {parts.map((part) => (
                      <span
                        key={part.key}
                        className="block w-full"
                        style={{
                          height: `${(part.value / day.costUsd) * 100}%`,
                          backgroundColor: part.color,
                        }}
                      />
                    ))}
                  </div>
                )}
                {showsValue && (
                  <span
                    className="absolute left-1/2 -translate-x-1/2 pb-[3px] text-[10px] leading-none font-bold whitespace-nowrap text-foreground"
                    style={{ bottom: `calc(${(day.costUsd / scale.max) * 100}% + 1px)` }}
                  >
                    {formatUsageUsd(day.costUsd)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-10 border-t-[1.5px] border-dashed border-sky-600 dark:border-sky-400"
          style={{ bottom: `${(average / scale.max) * 100}%` }}
        >
          <em className="absolute right-0 bottom-[3px] rounded-full border border-sky-600 bg-card px-1.5 py-px text-[10.5px] leading-snug font-bold text-sky-700 not-italic dark:border-sky-400 dark:text-sky-300">
            平均 {formatUsageUsd(average)}
          </em>
        </div>
      </div>
      <div className={cn("col-start-2 mt-1 flex", barsGap)}>
        {days.map((day, index) => {
          const fromLatest = days.length - 1 - index;
          const showsLabel = showsEveryLabel || fromLatest % DAILY_LABEL_EVERY_DAYS === 0;
          return (
            <span
              key={day.date}
              className={cn(
                "flex h-[1.3em] min-w-0 flex-1 justify-center whitespace-nowrap",
                !showsLabel && "invisible",
                day.date === todayKey && "font-bold text-foreground",
              )}
            >
              {formatMonthDay(`${day.date}T00:00:00+09:00`)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 日別カードの凡例（#3038）。**Claude／Codexは濃淡の4段（`AGENT_MODEL_TIER_COLORS`）で
 * 「濃いほど重いモデル」を示す**（#3396。実行状況の●の凡例`ModelDotLegend`と同じ体裁）。
 * GitHub Actionsは単色のまま。トークンの帯は日別では出さない（#3038）。
 */
function DailyLegend() {
  const agents = [
    { key: "claude", label: "Claude" },
    { key: "codex", label: "Codex" },
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {agents.map((agent) => (
        <span key={agent.key} className="inline-flex items-center gap-1">
          <span className="inline-flex items-center gap-0.5" aria-hidden>
            {AGENT_MODEL_TIER_COLORS[agent.key].map((color) => (
              <span
                key={color}
                className="size-2 rounded-full ring-1 ring-black/10 dark:ring-white/30"
                style={{ backgroundColor: color }}
              />
            ))}
          </span>
          <span className="text-foreground">{agent.label}</span>
        </span>
      ))}
      <span>濃いほど重いモデル</span>
      <span>
        <i
          aria-hidden
          className="mr-1 inline-block size-2 rounded-[2px]"
          style={{ backgroundColor: AGENT_COLORS.actions }}
        />
        <span className="text-foreground">GitHub Actions</span>
      </span>
      <span>
        <i
          aria-hidden
          className="mr-1.5 inline-block w-4 border-t-[1.5px] border-dashed border-sky-600 align-middle dark:border-sky-400"
        />
        <span className="text-foreground">期間の平均</span>
      </span>
    </div>
  );
}

/**
 * 種別別の内訳。**金額の棒だけで描く**（#3064。以前は細い帯〈トークン〉との二段だった。#2633）。
 * **リポジトリ別は円グラフ（`RepositoryPieChart`）へ替えた**（#3060）。
 * **太い棒の内側は日別の縦棒と同じ3分割**（Claude／Codex／GitHub Actions）にする。ここだけ
 * 「Claude／それ以外」の2分割だったため、同じ画面の同じ色が行によって別の意味になっていた。
 */
function Breakdown({
  title,
  hint,
  rows,
  colorOf,
  separator,
}: {
  title: string;
  hint: string;
  rows: (UsageGroup & { label: string })[];
  colorOf?: (key: string) => string | undefined;
  /** 条件に合う最初の行の手前へ区切りを入れる（#2954）。先頭の行が合うときは入れない */
  separator?: { label: string; isBefore: (key: string) => boolean };
}) {
  // **棒の基準は先頭の行ではなく最大の行**（#2954）。種別別は作業の順に並べるため、先頭が最大とは限らない。
  const max = rows.reduce((peak, row) => Math.max(peak, row.costUsd), 0);
  const separatorIndex = separator ? rows.findIndex((row) => separator.isBefore(row.key)) : -1;

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
          {rows.map((row, index) => {
            const color = colorOf?.(row.key);
            return (
              <Fragment key={row.key}>
                {/* 先頭の行の手前には入れない（流れの外の種別しか無い期間に、区切りだけが浮く） */}
                {separator && index > 0 && index === separatorIndex && (
                  <li className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span aria-hidden className="h-px flex-1 border-t border-dashed" />
                    {separator.label}
                    <span aria-hidden className="h-px flex-1 border-t border-dashed" />
                  </li>
                )}
                <li className="flex flex-col gap-1">
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
                  <CostBar row={row} widthPercent={max > 0 ? (row.costUsd / max) * 100 : 0} />
                </li>
              </Fragment>
            );
          })}
        </ul>
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
 * 中の各セッションを展開する。`Breakdown`の行（種別別）と同じ金額の棒に、トークンの帯を足して描く。
 */
/**
 * Issue1件ぶんの種別別内訳（#3410）。「セッション種別別」（`Breakdown`）と同じ色・並び順
 * （`KIND_ROW_COLORS`・`isUsageKindInWorkFlow`・`sessionUsageKindLabel`）で、そのIssue・PRに
 * 絞って出す。展開したセッション明細（`SessionCards`）の上に置く。
 *
 * **`Breakdown`とは別のコンポーネントにした。** `Breakdown`は#3064で金額の棒だけに絞ったが、
 * ここはIssue単位で行数が少なく（多くて9行）、モデルバッジとトークン量まで出しても読める。
 */
function IssueKindBreakdown({ rows }: { rows: UsageIssue["byKind"] }) {
  if (rows.length === 0) return null;
  const max = rows.reduce((peak, row) => Math.max(peak, row.costUsd), 0);
  const separatorIndex = rows.findIndex((row) => !isUsageKindInWorkFlow(row.key));

  return (
    <div className="mb-1.5 flex flex-col gap-1.5 border-b pb-2">
      <span className="text-[10px] font-semibold text-muted-foreground">種別別</span>
      {rows.map((row, index) => {
        const color = KIND_ROW_COLORS[row.key];
        return (
          <Fragment key={row.key}>
            {/* #2954と同じ区切り。先頭の行が流れの外なら区切りは入れない */}
            {index > 0 && index === separatorIndex && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span aria-hidden className="h-px flex-1 border-t border-dashed" />
                作業の流れの外
                <span aria-hidden className="h-px flex-1 border-t border-dashed" />
              </div>
            )}
            <div className="flex flex-col gap-1 text-[11px]">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium">
                  {color && (
                    <span
                      aria-hidden
                      className="size-[7px] shrink-0 rounded-[2px]"
                      style={{ backgroundColor: color }}
                    />
                  )}
                  <span className="truncate">{sessionUsageKindLabel(row.key)}</span>
                  {row.models.map((model) => (
                    <span
                      key={model}
                      className="shrink-0 rounded border bg-muted px-1 py-px text-[9px] font-medium text-foreground"
                    >
                      {sessionUsageModelLabel(model)}
                    </span>
                  ))}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{row.sessions}セッション</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CostBar row={row} widthPercent={max > 0 ? (row.costUsd / max) * 100 : 0} />
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {formatUsageTokens(row.contextTokens + row.outputTokens)}
                </span>
                <span className="w-12 shrink-0 text-right font-semibold tabular-nums">{formatUsageUsd(row.costUsd)}</span>
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Issue行の右上に出す実行時間。最も早い開始〜最も遅い終了（#3432） */
function issueRunSpanLabel(entries: Pick<SessionUsageEntry, "startedAt" | "endedAt">[]): string {
  if (entries.length === 0) return "";
  const start = entries.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), entries[0].startedAt);
  const end = entries.reduce((max, e) => (e.endedAt > max ? e.endedAt : max), entries[0].endedAt);
  const startLabel = formatDateTime(start);
  const endLabel = formatDateTime(end);
  if (!endLabel) return startLabel;
  const sameDay = startLabel.split(" ")[0] === endLabel.split(" ")[0];
  return `${startLabel} 〜 ${sameDay ? formatTimeOfDay(end) : endLabel}`;
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
            </div>
            {/* Issue・PRのタイトル（#2686）。取得できなかった行は出さず番号のみのままにする */}
            {issue.title && (
              <p className="mt-0.5 truncate text-[11px] text-foreground" title={issue.title}>
                {issue.title}
              </p>
            )}
            {/* 実行された種別のひと目表示（#3410）。開かなくても大まかな内訳が分かるように、
                色を持つ種別（実装のフェーズ）はドットだけ、色を持たない種別（計画レビュー等）は
                短いラベルで示す。詳細は行を開いたときの`IssueKindBreakdown`に譲る */}
            {issue.byKind.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {issue.byKind.map((row) => {
                  const color = KIND_ROW_COLORS[row.key];
                  return color ? (
                    <span
                      key={row.key}
                      aria-hidden
                      className="size-[6px] shrink-0 rounded-[1.5px]"
                      style={{ backgroundColor: color }}
                    />
                  ) : (
                    <span key={row.key} className="shrink-0 text-[9px] text-muted-foreground">
                      {sessionUsageKindLabel(row.key)}
                    </span>
                  );
                })}
                <span className="sr-only">
                  実行された種別: {issue.byKind.map((row) => sessionUsageKindLabel(row.key)).join("・")}
                </span>
              </div>
            )}
            {/* 金額・トークン量は棒グラフの右に置く（#3432）。右端の列をそろえるため幅を固定する */}
            <div className="mt-1 flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CostBar row={issue} widthPercent={maxCost > 0 ? (issue.costUsd / maxCost) * 100 : 0} />
                </div>
                <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">
                  {formatUsageUsd(issue.costUsd)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <GroupTokenBar totals={issue} maxTokens={maxTokens} />
                </div>
                <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                  {formatUsageTokens(issue.contextTokens + issue.outputTokens)}
                </span>
              </div>
            </div>
          </div>
        </button>
        {/* 右上は金額ではなく実行時間（開始日時〜終了時刻）。終了の日付は開始日から分かるので
            省く。日をまたぐときだけ日付を添える（#3432） */}
        <span className="shrink-0 px-1.5 pt-2.5 text-right text-[11px] text-muted-foreground tabular-nums">
          {issueRunSpanLabel(issue.entries)}
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
          <IssueKindBreakdown rows={issue.byKind} />
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

/** 状態のピルの色（#3084）。作業中＝緑、人を待っている＝橙、応答を終えている＝中立色 */
const CURRENT_SESSION_TONE_CLASS: Record<CurrentSessionTone, string> = {
  running: "border-emerald-600/45 text-emerald-700 dark:text-emerald-400",
  waiting: "border-amber-600/45 text-amber-700 dark:text-amber-400",
  idle: "border-stone-500/45 text-stone-600 dark:text-stone-400",
};

const CURRENT_SESSION_DOT_CLASS: Record<CurrentSessionTone, string> = {
  running: "bg-emerald-600 dark:bg-emerald-400",
  waiting: "bg-amber-600 dark:bg-amber-400",
  idle: "bg-stone-500 dark:bg-stone-400",
};

/** 閉じた状態の棒と凡例で使う状態の名前。並びもこの順（作業中 → 人を待っている → 応答を終えている） */
const CURRENT_SESSION_TONE_LABEL: Record<CurrentSessionTone, string> = {
  running: "作業中",
  waiting: "確認待ち",
  idle: "応答を終えている",
};

const CURRENT_SESSION_TONE_ORDER: CurrentSessionTone[] = ["running", "waiting", "idle"];

type OpenIssueHandler = (repository: string, issueNumber: number | null, prNumber: number | null) => void;

/**
 * 閉じた状態の棒グラフ（#3134）。**セッションごとの金額を足し上げた1本の横棒**で、区間の長さが
 * そのセッションの金額、色が状態。区間の間に隙間を空けて本数を数えられるようにし、まだ金額が
 * 届いていない（集計待ち・$0の）セッションも最小幅の区間で残す（消すと本数が合わなくなる）。
 * **合計金額は棒の右端に置く**（#3242）。見出しに入れると、スマホで「押すと詳細」が折り返す。
 */
function CurrentSessionCountBar({ sessions, totalCost }: { sessions: CurrentSessionUsage[]; totalCost: number }) {
  const counts = CURRENT_SESSION_TONE_ORDER.map((tone) => ({
    tone,
    count: sessions.filter((session) => session.statusTone === tone).length,
  })).filter(({ count }) => count > 0);
  const hasCost = sessions.some((session) => session.costUsd > 0);
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex items-center gap-3">
        <span className="flex h-3 min-w-0 flex-1 gap-[3px]" data-testid="current-session-count-bar">
          {sessions.map((session) => (
            <i
              key={`${session.host}:${session.tmuxSessionName}`}
              aria-hidden
              className={cn(
                "min-w-1.5 basis-0 rounded-[3px]",
                CURRENT_SESSION_DOT_CLASS[session.statusTone],
                !session.reported && "opacity-40",
              )}
              // 金額が1件も届いていなければ均等に割る（全区間が最小幅に潰れるのを避ける）
              style={{ flexGrow: hasCost ? session.costUsd : 1 }}
              title={`#${session.issueNumber} ${session.statusLabel}　${session.reported ? formatUsageUsd(session.costUsd) : "集計待ち"}`}
            />
          ))}
        </span>
        <span
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
          data-testid="current-session-total-cost"
        >
          計 <b className="text-sm font-semibold text-foreground">{formatUsageUsd(totalCost)}</b>
        </span>
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
        {counts.map(({ tone, count }) => (
          <span key={tone} className="inline-flex items-center gap-1">
            <i aria-hidden className={cn("size-2 rounded-[2px]", CURRENT_SESSION_DOT_CLASS[tone])} />
            {CURRENT_SESSION_TONE_LABEL[tone]}
            <b className="font-semibold text-foreground">{count}</b>
          </span>
        ))}
      </span>
    </span>
  );
}

/** 行の見出し（Issue番号・リポジトリ・タイトル・状態・モデル）。`elapsed`を渡すと1行目の右端へ置く */
function CurrentSessionHeading({ session, elapsed }: { session: CurrentSessionUsage; elapsed: string | null }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
        <span
          aria-hidden
          className="size-[7px] shrink-0 self-center rounded-[2px]"
          style={{ backgroundColor: AGENT_COLORS[session.agent] }}
          title={session.agent === "claude" ? "Claude" : "Codex"}
        />
        <span className="shrink-0 font-semibold">#{session.issueNumber}</span>
        <span className="min-w-0 truncate text-muted-foreground">{session.repository}</span>
        {elapsed && (
          <span className="ml-auto shrink-0 pl-2 text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">
            開始から {elapsed}
          </span>
        )}
      </div>
      {session.title && (
        <p className="mt-0.5 truncate text-[11px]" title={session.title}>
          {session.title}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold",
            CURRENT_SESSION_TONE_CLASS[session.statusTone],
          )}
        >
          <i aria-hidden className={cn("size-1.5 rounded-full", CURRENT_SESSION_DOT_CLASS[session.statusTone])} />
          {session.statusLabel}
        </span>
        {session.models.map((model) => (
          <span
            key={model}
            className="shrink-0 rounded border bg-muted px-1 py-px text-[9px] font-medium text-foreground"
          >
            {sessionUsageModelLabel(model)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 金額の棒と、その下の5時間枠の割合。`trailing`は同じ行の右側へ置く（スマホの応答数・入力トークン） */
function CurrentSessionBar({
  session,
  maxCost,
  trailing,
}: {
  session: CurrentSessionUsage;
  maxCost: number;
  trailing?: ReactNode;
}) {
  if (!session.reported) {
    return (
      <div>
        <div className="h-2 rounded-full bg-muted" />
        <p className="mt-0.5 text-[10px] text-muted-foreground italic">集計待ち（20秒おきに報告）</p>
      </div>
    );
  }
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{
            width: `${maxCost > 0 ? (session.costUsd / maxCost) * 100 : 0}%`,
            backgroundColor: AGENT_COLORS[session.agent],
          }}
        />
      </div>
      <div className="mt-0.5 flex flex-wrap justify-between gap-x-2 text-[10px] text-muted-foreground tabular-nums">
        {session.quotaPercent !== null ? (
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            5時間枠の約{session.quotaPercent.toFixed(1)}%
          </span>
        ) : (
          <span>プラン枠の換算なし</span>
        )}
        {trailing}
      </div>
    </div>
  );
}

function OpenIssueButton({ session, onOpenIssue }: { session: CurrentSessionUsage; onOpenIssue?: OpenIssueHandler }) {
  if (!onOpenIssue) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-5 shrink-0"
      title="Issueを開く"
      onClick={() => onOpenIssue(session.repository, session.issueNumber, null)}
    >
      <ExternalLink className="size-3" />
      <span className="sr-only">Issueを開く</span>
    </Button>
  );
}

/**
 * 「実行中のセッション」欄（#3084）。**いまサブPCで生きているセッションごとに、始まってからの
 * 使用量を並べる。** 画面のいちばん上に置き、期間（1日/7日/30日）には連動しない。
 *
 * 材料は実行状況パネルと同じセッション一覧と、pollerが20秒おきに送る動いている転記の使用量で
 * （#3135）、画面を開いている間は20秒おきに取り直す。使用量がまだ届いていないセッションは
 * 「集計待ち」と出す。PCは列を揃えた表、スマホ（`compact`）は
 * 1本1カードで、応答数・入力トークンを5時間枠の割合と同じ行へ寄せる。
 *
 * **最初は閉じた状態で、本数を示す棒グラフだけを出す**（#3134）。何本も動いていると詳細が
 * 画面上部を埋め、期間の集計まで遠くなるため。見出しか棒を押すと上の詳細が開く。
 */
function CurrentSessionsSection({
  sessions,
  reportedAt,
  compact,
  onOpenIssue,
}: {
  sessions: CurrentSessionUsage[];
  reportedAt: string | null;
  compact: boolean;
  onOpenIssue?: OpenIssueHandler;
}) {
  const now = useNow();
  // 既定は閉じた状態（#3134）。開閉は記憶せず、画面を開くたびに閉じた状態から始める
  const [isOpen, setIsOpen] = useState(false);
  const totalCost = sessions.reduce((sum, session) => sum + session.costUsd, 0);
  const maxCost = sessions.reduce((peak, session) => Math.max(peak, session.costUsd), 0);
  const elapsedOf = (session: CurrentSessionUsage) =>
    now === null ? null : formatSessionElapsed(session.startedAt, now);

  if (sessions.length === 0) {
    return (
      <section aria-label="実行中のセッション" className="flex flex-col gap-2 rounded-lg border p-3">
        <span className="text-xs font-semibold">実行中のセッション</span>
        <p className="text-xs text-muted-foreground">いま実行中のセッションはありません</p>
      </section>
    );
  }

  return (
    <section
      aria-label="実行中のセッション"
      className="flex flex-col gap-2 rounded-lg border border-emerald-600/60 p-3 dark:border-emerald-400/50"
    >
      {/* 見出しと棒をまとめて1つのボタンにする（#3134）。どこを押しても開閉する */}
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="-m-1 flex flex-col gap-2 rounded-md p-1 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {/* 1行に収める（#3242）。幅が足りないときは本数・報告時刻の部分だけが「…」に縮み、
            見出しと「押すと詳細」は残る */}
        <span className="flex w-full items-baseline gap-x-2 whitespace-nowrap">
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 self-center text-muted-foreground transition-transform",
                isOpen && "rotate-90",
              )}
            />
            <i aria-hidden className="size-2 rounded-full bg-emerald-600 ring-[3px] ring-emerald-600/25 dark:bg-emerald-400" />
            実行中のセッション
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground tabular-nums">
            {sessions.length}本{reportedAt ? `・${formatRelativeDate(reportedAt)}の報告` : ""}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {isOpen ? "押すと閉じる" : "押すと詳細"}
          </span>
        </span>
        <CurrentSessionCountBar sessions={sessions} totalCost={totalCost} />
      </button>

      {!isOpen ? null : compact ? (
        <ul className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <li
              key={`${session.host}:${session.tmuxSessionName}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 rounded-lg border p-2.5"
            >
              <CurrentSessionHeading session={session} elapsed={null} />
              <div className="flex flex-col items-end justify-between gap-1">
                <span className="text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">
                  {elapsedOf(session) ? `開始から ${elapsedOf(session)}` : ""}
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-xs font-semibold tabular-nums">
                    {session.reported ? formatUsageUsd(session.costUsd) : "—"}
                  </span>
                  <OpenIssueButton session={session} onOpenIssue={onOpenIssue} />
                </span>
              </div>
              <div className="col-span-2">
                <CurrentSessionBar
                  session={session}
                  maxCost={maxCost}
                  trailing={
                    <span>
                      {`${session.responses.toLocaleString()}応答　入力トークン ${formatUsageTokens(session.contextTokens)}`}
                    </span>
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <ul className="flex min-w-[44rem] flex-col gap-0.5">
            <li className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.4fr)_4.5rem_4rem_5.5rem_1.25rem] gap-2.5 px-1.5 text-[10px] font-semibold text-muted-foreground">
              <span>Issue・状態</span>
              <span>金額（最大との比較）</span>
              <span className="text-right">金額</span>
              <span className="text-right">応答</span>
              <span className="text-right">入力トークン</span>
              <span />
            </li>
            {sessions.map((session) => (
              <li
                key={`${session.host}:${session.tmuxSessionName}`}
                className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.4fr)_4.5rem_4rem_5.5rem_1.25rem] items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent/50"
              >
                <CurrentSessionHeading session={session} elapsed={elapsedOf(session)} />
                <CurrentSessionBar session={session} maxCost={maxCost} />
                <span className="text-right text-xs font-semibold tabular-nums">
                  {session.reported ? formatUsageUsd(session.costUsd) : "—"}
                </span>
                <span className="text-right text-[11px] tabular-nums">
                  {session.reported ? session.responses.toLocaleString() : "—"}
                </span>
                <span className="text-right text-[11px] tabular-nums">
                  {session.reported ? formatUsageTokens(session.contextTokens) : "—"}
                </span>
                <OpenIssueButton session={session} onOpenIssue={onOpenIssue} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {isOpen && (
        <p className="text-[10px] text-muted-foreground">
          状態と金額は画面を開いている間、20秒おきに更新します。金額はセッション開始からの累計（API換算の目安）で、期間の切り替えには連動しません。
        </p>
      )}
    </section>
  );
}

/**
 * 取得待ちの灰色の帯（#3304）。`ui/skeleton.tsx`は`animate-pulse`を持つだけなので、
 * `prefers-reduced-motion`のときに点滅を止める指定をここで足す。
 */
function Bone({ className, style }: { className?: string; style?: CSSProperties }) {
  return <Skeleton aria-hidden className={cn("motion-reduce:animate-none", className)} style={style} />;
}

/**
 * 「実行中のセッション」欄の取得待ち（#3304）。届いた結果が0本でも1枠の高さで済むよう、
 * 空のときの表示（見出し＋1行）と同じ形にする。
 */
function CurrentSessionsSkeleton() {
  return (
    <section
      aria-label="実行中のセッション"
      aria-busy="true"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <span className="text-xs font-semibold">実行中のセッション</span>
      <Bone className="h-4 w-48 max-w-full" />
      <span className="sr-only" role="status">
        実行中のセッションを読み込み中
      </span>
    </section>
  );
}

/** 合計タイル1枚の取得待ち。見出しは実物と同じ文字を出し、値と補足だけを帯にする */
function TileSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">{label}</span>
      <Bone className="my-0.5 h-6 w-24 sm:h-7" />
      <Bone className="mt-0.5 h-3 w-full max-w-40" />
    </div>
  );
}

/** 日別の縦棒の高さ（%）。何日ぶん届くかは分からないので、7本の見本で「棒グラフが入る」形だけを示す */
const DAILY_SKELETON_HEIGHTS = [40, 62, 30, 78, 55, 90, 34] as const;

/**
 * 期間の集計（タイル・日別・リポジトリ別・種別別・Issue・PR別）の取得待ち（#3304）。**枠と見出しは
 * 実物と同じものを先に描き、中身だけを灰色の帯にする。** 届いた瞬間に位置がずれないよう、
 * タイル・グラフの高さと2カラムの構成を実物に合わせる（**`SessionUsagePanel`の並びを変えるときは
 * ここも直す**）。期間を切り替えて集計が届くまでの間にも同じものを出す。
 */
function PeriodSkeleton({ compact }: { compact: boolean }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <span className="sr-only" role="status">
        集計を読み込み中
      </span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TileSkeleton label="従量課金相当" />
        <TileSkeleton label="応答" />
        <TileSkeleton label="入力トークン" />
        <TileSkeleton label="セッション" />
      </div>

      <section className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold">日別</span>
        </div>
        {/* 実物の`DailyChart`は縦軸2.4〜2.9rem＋高さ`h-52`。棒は下端をそろえて並べる */}
        <div className="flex h-52 items-end gap-2 pl-[2.4rem] sm:gap-3 sm:pl-[2.9rem]">
          {DAILY_SKELETON_HEIGHTS.map((height, index) => (
            <Bone
              key={index}
              className="flex-1 rounded-b-none"
              // 棒の高さは見本の値で、データではない
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </section>

      <div className={cn("grid items-start gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <section className="flex flex-col gap-2 rounded-lg border p-3">
          <span className="shrink-0 text-xs font-semibold whitespace-nowrap">リポジトリ別</span>
          <Bone className="mx-auto size-32 rounded-full" />
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2, 3].map((row) => (
              <Bone key={row} className="h-3 w-full" />
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-2 rounded-lg border p-3">
          <span className="shrink-0 text-xs font-semibold whitespace-nowrap">セッション種別別</span>
          <ul className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <li key={row} className="flex flex-col gap-1">
                <Bone className="h-3 w-2/3" />
                <Bone className="h-2 w-full" />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="flex flex-col gap-1 rounded-lg border p-3">
        <span className="text-xs font-semibold">Issue・PR別</span>
        <ul className="flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <li key={row} className="flex flex-col gap-1.5 px-1.5 py-1.5">
              <Bone className="h-3.5 w-3/4" />
              <Bone className="h-2 w-full" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * プラン枠そのもの。**実測のメーター**で、Claude・Codexを並べて置く。
 *
 * **期間の切り替えでは描き直さない**（#3257）。受け取るのは期間に連動しない値だけで、
 * `use-session-usage.ts`がプラン枠を集計と別の状態として持つので、`memo`が効いて再描画されない。
 */
const PlanUsageSection = memo(function PlanUsageSection({
  claude,
  codex,
  claudeNotConfigured,
  codexNotConfigured,
  quotaEstimate,
  isLoading,
  error,
}: {
  claude: SessionUsagePlan["planUsage"]["claude"];
  codex: SessionUsagePlan["planUsage"]["codex"];
  claudeNotConfigured: boolean;
  codexNotConfigured: boolean;
  quotaEstimate: SessionUsagePlan["quotaEstimate"];
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <section className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-semibold">Claude プラン枠</p>
        <ClaudeUsageCard
          data={claude}
          isLoading={isLoading}
          error={error}
          notConfigured={claudeNotConfigured}
          quotaEstimate={quotaEstimate}
        />
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold">Codex プラン枠</p>
        <CodexUsageCard
          data={codex}
          isLoading={isLoading}
          error={error}
          notConfigured={codexNotConfigured}
        />
      </div>
    </section>
  );
});

/** 明細に出すIssueの件数。全部並べると30日で数百行になり、上位が読めなくなる */
const VISIBLE_ISSUES_STEP = 20;

export function SessionUsagePanel({
  data,
  plan,
  isLoading,
  error,
  days,
  onChangeDays,
  onRefresh,
  onOpenIssue,
  compact = false,
  className,
}: SessionUsagePanelProps) {
  const [visibleIssues, setVisibleIssues] = useState(VISIBLE_ISSUES_STEP);
  // Issue・PRの行ごとの開閉状態。キーが無ければ既定（一番新しい行だけ開く）に従う（#2653）。
  const [openIssueKeys, setOpenIssueKeys] = useState<Record<string, boolean>>({});

  // **期間の集計は、選択中の期間の応答が届いてから出す。** 期間を変えたときは前の応答が残っている
  // （プラン枠と実行中のセッションを消さないため。`use-session-usage.ts`）ので、`days`で見分ける
  const period = data && data.days === days ? data : null;
  const totals = period?.totals;
  const perResponseUsd = totals && totals.responses > 0 ? totals.costUsd / totals.responses : 0;
  const avgContext =
    totals && totals.responses > 0 ? Math.round(totals.contextTokens / totals.responses) : 0;
  const planReview = period?.byKind.find((kind) => kind.key === "plan-review");
  // 日別は期間の全日を並べる（記録の無い日は0で埋める。#3038）。最後の日が「集計中の今日」
  const dailyDays = period ? fillUsageDays(period.byDay, period.since, period.until) : [];
  const todayKey = dailyDays.at(-1)?.date ?? "";
  const issues = period?.byIssue ?? [];
  const repositoryPieSlices = period ? buildRepositoryPieSlices(period.byRepository) : [];
  const agentCostSub = period
    ? `Claude ${formatUsageUsd(period.totalsByAgent.claude.costUsd)}・Codex ${formatUsageUsd(period.totalsByAgent.codex.costUsd)}・Actions ${formatUsageUsd(period.totalsBySource["github-actions"].costUsd)}`
    : "";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* **見出しの右横にいつの報告かを出し、更新ボタンを右端に置く**（#3257）。材料はpollerが
          5分おきに押し込む記録で、開いた瞬間の値ではない（古いまま止まっていることに気付けるように
          する）。20秒おきに新しくなるのは「実行中のセッション」欄だけ（#3135） */}
      <header className="flex items-center gap-2.5">
        <h2 className="shrink-0 text-sm font-bold">AI使用量</h2>
        {data?.reportedAt && (
          <p className="min-w-0 truncate text-[11px] text-muted-foreground">
            {`${data.hosts.join("・") || "subpc"} から ${formatRelativeDate(data.reportedAt)}`}
          </p>
        )}
        <Button
          variant="outline"
          size="icon"
          className="ml-auto size-7 shrink-0"
          onClick={onRefresh}
          title="更新"
        >
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          <span className="sr-only">更新</span>
        </Button>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* いま動いているセッション（#3084）。期間の集計より先に、画面のいちばん上へ置く。
          届くまでは枠だけ先に描く（#3304） */}
      {data ? (
        <CurrentSessionsSection
          sessions={data.currentSessions ?? []}
          reportedAt={data.reportedAt}
          compact={compact}
          onOpenIssue={onOpenIssue}
        />
      ) : (
        !error && <CurrentSessionsSkeleton />
      )}

      <PlanUsageSection
        claude={plan.data?.planUsage.claude ?? null}
        codex={plan.data?.planUsage.codex ?? null}
        claudeNotConfigured={plan.data?.planNotConfigured.claude ?? false}
        codexNotConfigured={plan.data?.planNotConfigured.codex ?? false}
        quotaEstimate={plan.data?.quotaEstimate ?? null}
        isLoading={plan.data === null && plan.error === null}
        error={plan.error}
      />

      {/* 期間の選択は**プラン枠の下**（#3257）。切り替わるのはこの下の集計だけで、プラン枠と
          実行中のセッションは期間に連動しない */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-semibold">集計期間</span>
        <Segmented
          ariaLabel="集計する期間"
          options={SESSION_USAGE_PERIODS.map((option) => ({
            value: option.days,
            label: option.label,
          }))}
          value={days}
          onChange={onChangeDays}
        />
        <span className="text-[11px] text-muted-foreground">この下の集計だけが切り替わります</span>
      </div>

      {/* 集計が届くまでは、実物と同じ枠のスケルトンを出す（#3304）。取得に失敗したときは
          スケルトンのまま止めず、上のエラー表示だけにする */}
      {!period && !error && <PeriodSkeleton compact={compact} />}

      {period && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label="従量課金相当"
              value={formatUsageUsd(period.totalsByAgent.claude.costUsd + period.totalsByAgent.codex.costUsd)}
              sub={agentCostSub}
            />
            <Tile
              label="応答"
              value={period.totals.responses.toLocaleString()}
              /* 入力トークンタイルのsubを内訳に使ったので、1応答あたりの平均はこちらへ寄せる */
              sub={`1応答 ${formatUsageUsd(perResponseUsd)}・平均 ${formatUsageTokens(avgContext)}`}
            />
            <Tile
              label="入力トークン"
              value={formatUsageTokens(period.totals.contextTokens)}
              bar={<ContextBar totals={period.totals} />}
              sub={`内訳 入力 ${formatUsageTokens(period.totals.inputTokens)}・書込 ${formatUsageTokens(period.totals.cacheCreateTokens)}・読出 ${formatUsageTokens(period.totals.cacheReadTokens)}`}
            />
            <Tile
              label="セッション"
              value={period.totals.sessions.toLocaleString()}
              /* 実装の本数は`byKind`から数えられない（フェーズごとの行へ割ってあり、
                 1本が最大5行に現れる）ため、集計側が数えた本数を使う（#2779） */
              sub={`実装 ${period.implementationSessions}・計画レビュー ${planReview?.sessions ?? 0}・Actions ${period.totalsBySource["github-actions"].sessions}`}
            />
          </div>

          <section className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">日別</span>
              {/* 棒の色と平均線の説明は下の`DailyLegend`に置く。枠線の意味（集計途中で必ず
                  低く出る）はここにしか無いので残す */}
              <span className="text-[11px] text-muted-foreground">
                いちばん新しい日は集計中
              </span>
            </div>
            <DailyLegend />
            <DailyChart days={dailyDays} todayKey={todayKey} />
          </section>

          <div
            className={cn("grid items-start gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}
          >
            {/* **リポジトリ別は円グラフ**（#3060）。金額の上位5件と「その他」だけで、エージェント・
                トークンの区別は持たない。下の凡例（太い棒＝金額／細い帯＝トークン）は当てはまらない */}
            <section className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-xs font-semibold whitespace-nowrap">リポジトリ別</span>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground tabular-nums">
                  {`${period.byRepository.length}リポジトリ・上位${REPOSITORY_PIE_TOP_COUNT}件＋その他`}
                </span>
              </div>
              {repositoryPieSlices.length === 0 ? (
                <p className="text-xs text-muted-foreground">記録がありません</p>
              ) : (
                <RepositoryPieChart slices={repositoryPieSlices} />
              )}
              <p className="text-[10px] text-muted-foreground">
                金額（API換算）の多い上位{REPOSITORY_PIE_TOP_COUNT}件。それ以外は「その他」にまとめています。
              </p>
            </section>
            <div className="flex flex-col gap-2">
              {/* **実装は1行にせず、セッションの中のフェーズへ割って並べる**（#2779）。
                  実装は全体の9割を占めるため、1行のままでは「実装が多い」以外に読めない。
                  **行は金額順ではなく作業の順**（#2954。並びは`compareUsageKinds`が決める） */}
              <Breakdown
                title="セッション種別別"
                hint="実装はフェーズで分割（転記から推定）"
                rows={period.byKind.map((row) => ({ ...row, label: sessionUsageKindLabel(row.key) }))}
                colorOf={(key) => KIND_ROW_COLORS[key]}
                separator={{
                  label: "作業の流れの外",
                  isBefore: (key) => !isUsageKindInWorkFlow(key),
                }}
              />
            </div>
          </div>

          {/* 太い棒＝金額／細い帯＝トークンの凡例。日別は縦棒（#3038）、リポジトリ別は円グラフ（#3060）、
              種別別は金額の棒だけ（#3064）になり、二段で描くのはIssue・PR別だけなのでその手前へ置く */}
          <TokenLegend />

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
                {period.omittedIssues > 0 && issues.length <= visibleIssues && (
                  <p className="pt-1 text-center text-[11px] text-muted-foreground">
                    ほか {period.omittedIssues.toLocaleString()} 件（合計{" "}
                    {formatUsageUsd(period.omittedIssueCostUsd)}
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
    </div>
  );
}
