"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import type {
  ClaudeApiTotals,
  ClaudeApiUsageFeature,
  ClaudeApiUsageModel,
  ClaudeApiUsageSummary,
  ClaudeApiUsageWindows,
} from "@/hooks/use-claude-api-usage";
import { estimateCostUsd, formatCostUsd } from "@/lib/ai-model-pricing";
import { useNow } from "@/hooks/use-now";
import { totalTokens } from "@/lib/claude/api-usage-totals";
import { formatDuration } from "@/lib/format-duration";

type ClaudeApiUsageListProps = {
  data: ClaudeApiUsageSummary | null;
  isLoading: boolean;
  error: string | null;
  /**
   * 集計する期間（日）。**画面上部の期間セレクタ（`SESSION_USAGE_PERIODS`）の値をそのまま渡す**
   * （#2752）。以前はこのカードだけが「過去1日／過去7日」の切り替えを自前で持っており、
   * 上を30日にしたまま下だけ1日を見ている、ということが起きていた。
   */
  days: number;
};

/** 機能ごとに表示するモデル内訳の件数 */
const MODELS_PER_FEATURE = 3;

/**
 * 表示する集計ウィンドウ。どちらもローリングウィンドウ。
 *
 * **GitHub API使用量のような「今時」（正時起点の1時間）は置かない**——あちらは正時でリセット
 * されるRESTのレート制限に合わせた区切りで、AI側に対応する枠が無い。プラン枠が5時間・週間
 * である以上、日単位と週単位の方が読み合わせやすい。
 */
type UsageMode = "last24h" | "last7d";

/**
 * 期間（日）からウィンドウを決める（#2752）。
 *
 * **30日は7日で代用する。** 集計そのものが直近7日ぶんしか無く（`api-usage.ts`の
 * `USAGE_WINDOW_MS`）、それより前は復元できない。黙って7日の値を出すと期間の指定と
 * 食い違うので、画面はそのことを断る（`SHORTER_THAN_REQUESTED_NOTE`）。
 */
function modeForDays(days: number): UsageMode {
  return days <= 1 ? "last24h" : "last7d";
}

/** 見出しに出す期間の名前。30日は実際に出している7日ぶんの名前で呼ぶ */
function modeLabelForDays(days: number): string {
  if (days <= 1) return "過去1日";
  if (days <= 7) return "過去7日";
  return "直近7日";
}

const SHORTER_THAN_REQUESTED_NOTE =
  "この内訳は直近7日ぶんです（それより前は保存していません）。";

function pick(totals: ClaudeApiUsageWindows, mode: UsageMode): ClaudeApiTotals {
  return mode === "last24h" ? totals.last24h : totals.last7d;
}

/** 「5回・18,432」のように、呼び出し回数とトークン数を並べる */
function formatTotals(totals: ClaudeApiTotals): string {
  return `${totals.calls.toLocaleString()}回・${totalTokens(totals).toLocaleString()}`;
}

/** モデル1行の内訳。キャッシュは発生したときだけ添える */
function formatBreakdown(totals: ClaudeApiTotals): string {
  const cache = totals.cacheReadTokens + totals.cacheCreationTokens;
  const base = `入力 ${totals.inputTokens.toLocaleString()} / 出力 ${totals.outputTokens.toLocaleString()}`;
  return cache > 0 ? `${base} / キャッシュ ${cache.toLocaleString()}` : base;
}

/**
 * 機能1件ぶんの概算コスト（#2717）。**モデル別の金額を足して出す。**
 *
 * 機能の行にはモデルが複数並ぶ（設定を切り替えた前後）ため、機能単位の単価というものが無い。
 * **1つでも単価を知らないモデルが混じっていたら`null`**——足りない分を黙って0として
 * 足すと、実際より安い金額が出る。
 */
function featureCostUsd(models: readonly ClaudeApiUsageModel[], mode: UsageMode): number | null {
  let sum = 0;
  for (const model of models) {
    const cost = estimateCostUsd(model.model, pick(model, mode));
    if (cost === null) return null;
    sum += cost;
  }
  return sum;
}

/**
 * 機能別のAI API消費の内訳（#2347）。
 * Anthropicはプラン枠の使用率しか返さないため、アプリが自分で投げた呼び出しを数え、
 * 応答の`usage`が返す実測のトークン数を積んだ値を表示する。
 * 見出しは呼び出し元（`session-usage-panel.tsx`の「アプリ内AI機能別」）が
 * 持つため、このコンポーネント自体は見出しを持たない。#2631までは設定の「状態」
 * （`settings/status-section.tsx`）のAI使用量カードの中にあった。
 *
 * **期間は自分で持たない**（#2752）。画面上部の期間セレクタの値を`days`で受け取る。
 */
export function ClaudeApiUsageList({ data, isLoading, error, days }: ClaudeApiUsageListProps) {
  const now = useNow();
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [showUnusedFeatures, setShowUnusedFeatures] = useState(false);
  const detailId = useId();
  const unusedId = useId();

  if (isLoading) return <p className="text-xs text-muted-foreground">読み込み中...</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return null;
  if (data.features.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        まだ消費が記録されていません（issue-deck本体の呼び出しのみ）
      </p>
    );
  }

  const mode = modeForDays(days);
  const measuredMs = now !== null ? now - data.measuringSince : null;
  const modeLabel = modeLabelForDays(days);
  const total = mode === "last24h" ? data.totalLast24h : data.totalLast7d;
  const totalTokenCount = totalTokens(total);

  // **その期間に1回も呼ばれていない機能は畳む**（#2752）。11機能のうち呼ばれるのは数件で、
  // 0回のカードが並ぶとスマホでは合計へ辿り着く前に画面が尽きる。件数は残すので、
  // 「その機能が存在すること」は畳んだままでも分かる。
  const usedFeatures = data.features.filter((feature) => pick(feature, mode).calls > 0);
  const unusedFeatures = data.features.filter((feature) => pick(feature, mode).calls === 0);

  const renderFeature = (feature: ClaudeApiUsageFeature) => {
    const totals = pick(feature, mode);
    const tokens = totalTokens(totals);
    const sharePercent = totalTokenCount > 0 ? (tokens / totalTokenCount) * 100 : 0;
    const cost = formatCostUsd(featureCostUsd(feature.models, mode));
    return (
      <li key={feature.key} className="rounded-lg border p-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium">{feature.label}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatTotals(totals)}
            {/* 金額は単価を知っているモデルだけで出す（#2717）。知らないモデルが
                混じっていたら出さない——足りない分を0として足すと安く見える */}
            {cost && <span className="text-foreground">{` / ${cost}`}</span>}
          </span>
        </div>
        <Progress value={sharePercent} />
        <ul className="mt-1 flex flex-col gap-0.5">
          {feature.models.slice(0, MODELS_PER_FEATURE).map((model) => {
            const modelCost = formatCostUsd(estimateCostUsd(model.model, pick(model, mode)));
            return (
              <li
                key={model.model}
                className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
              >
                <span className="truncate" title={model.model}>
                  {model.model}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatBreakdown(pick(model, mode))}
                  {modelCost && ` / ${modelCost}`}
                </span>
              </li>
            );
          })}
        </ul>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {/* 内訳に出ない消費（無人実行・ローカルセッション）の方が大きいことがあるため、
          畳んでいる状態でも「何を数えた値なのか」が分かるようにしておく。 */}
      <p className="text-[10px] text-muted-foreground">
        issue-deck本体の呼び出しのみ。無人実行・ローカルセッションの消費は上のプラン枠に含まれます。
        {days > 7 && (
          <>
            <br />
            <span className="font-semibold">{SHORTER_THAN_REQUESTED_NOTE}</span>
          </>
        )}
      </p>
      <button
        type="button"
        aria-expanded={isDetailOpen}
        aria-controls={detailId}
        onClick={() => setIsDetailOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="tabular-nums">
          {modeLabel} {total.calls.toLocaleString()}回・{totalTokenCount.toLocaleString()}トークン
        </span>
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${isDetailOpen ? "rotate-90" : ""}`}
        />
      </button>
      {isDetailOpen && (
        <div id={detailId} className="flex flex-col gap-2">
          {usedFeatures.length > 0 && (
            <ul className="flex flex-col gap-2">{usedFeatures.map(renderFeature)}</ul>
          )}
          {unusedFeatures.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={showUnusedFeatures}
                aria-controls={unusedId}
                onClick={() => setShowUnusedFeatures((prev) => !prev)}
                className="flex items-center gap-1 self-start rounded-md text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={`size-3 shrink-0 transition-transform ${showUnusedFeatures ? "rotate-90" : ""}`}
                />
                0回の機能 {unusedFeatures.length}件
              </button>
              {showUnusedFeatures && (
                <ul id={unusedId} className="flex flex-wrap gap-1">
                  {unusedFeatures.map((feature) => (
                    <li
                      key={feature.key}
                      className="rounded-full border px-1.5 text-[10px] text-muted-foreground"
                    >
                      {feature.label}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="text-[10px] text-muted-foreground">
            「{modeLabel}」の回数とトークン数（入力・出力・キャッシュの合計）と、
            そのトークン数から割ったAPI換算の目安金額（プランの実費ではありません）。
            {measuredMs !== null && `計測期間は直近${formatDuration(measuredMs)}。`}
            直近7日分をDBへ保存しており、アプリの再起動をまたいでも記録を引き継ぎます。
          </p>
        </div>
      )}
    </div>
  );
}
