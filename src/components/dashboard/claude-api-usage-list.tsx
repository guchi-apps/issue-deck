"use client";

import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  ClaudeApiTotals,
  ClaudeApiUsageSummary,
  ClaudeApiUsageWindows,
} from "@/hooks/use-claude-api-usage";
import { useNow } from "@/hooks/use-now";
import { totalTokens } from "@/lib/claude/api-usage-totals";
import { formatDuration } from "@/lib/format-duration";

type ClaudeApiUsageListProps = {
  data: ClaudeApiUsageSummary | null;
  isLoading: boolean;
  error: string | null;
};

/** 機能ごとに表示するモデル内訳の件数 */
const MODELS_PER_FEATURE = 3;

/**
 * 表示する集計モード。どちらもローリングウィンドウ。
 *
 * **GitHub API使用量のような「今時」（正時起点の1時間）は置かない**——あちらは正時でリセット
 * されるRESTのレート制限に合わせた区切りで、AI側に対応する枠が無い。プラン枠が5時間・週間
 * である以上、日単位と週単位の方が読み合わせやすい。
 */
type UsageMode = "last24h" | "last7d";

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
 * 機能別のAI API消費の内訳（#2347）。
 * Anthropicはプラン枠の使用率しか返さないため、アプリが自分で投げた呼び出しを数え、
 * 応答の`usage`が返す実測のトークン数を積んだ値を表示する。
 * 見出し「AI使用量」は呼び出し元（`settings/status-section.tsx`）がプラン枠のメーターと
 * 共通で表示するため、このコンポーネント自体は見出しを持たない。
 */
export function ClaudeApiUsageList({ data, isLoading, error }: ClaudeApiUsageListProps) {
  const now = useNow();
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [mode, setMode] = useState<UsageMode>("last24h");
  const detailId = useId();

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

  const measuredMs = now !== null ? now - data.measuringSince : null;
  const modeLabel = mode === "last24h" ? "過去1日" : "過去7日";
  const total = mode === "last24h" ? data.totalLast24h : data.totalLast7d;
  const totalTokenCount = totalTokens(total);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "last24h"}
          onClick={() => setMode("last24h")}
        >
          過去1日
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={mode === "last7d"}
          onClick={() => setMode("last7d")}
        >
          過去7日
        </Button>
      </div>
      {/* 内訳に出ない消費（無人実行・ローカルセッション）の方が大きいことがあるため、
          畳んでいる状態でも「何を数えた値なのか」が分かるようにしておく。 */}
      <p className="text-[10px] text-muted-foreground">
        issue-deck本体の呼び出しのみ。無人実行・ローカルセッションの消費は上のプラン枠に含まれます。
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
          <ul className="flex flex-col gap-2">
            {data.features.map((feature) => {
              const totals = pick(feature, mode);
              const tokens = totalTokens(totals);
              const sharePercent = totalTokenCount > 0 ? (tokens / totalTokenCount) * 100 : 0;
              return (
                <li key={feature.key} className="rounded-lg border p-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{feature.label}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatTotals(totals)}
                    </span>
                  </div>
                  <Progress value={sharePercent} />
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {feature.models.slice(0, MODELS_PER_FEATURE).map((model) => (
                      <li
                        key={model.model}
                        className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                      >
                        <span className="truncate" title={model.model}>
                          {model.model}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {formatBreakdown(pick(model, mode))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-muted-foreground">
            「{modeLabel}」の回数とトークン数（入力・出力・キャッシュの合計）。
            {measuredMs !== null && `計測期間は直近${formatDuration(measuredMs)}。`}
            直近7日分をDBへ保存しており、アプリの再起動をまたいでも記録を引き継ぎます。
          </p>
        </div>
      )}
    </div>
  );
}
