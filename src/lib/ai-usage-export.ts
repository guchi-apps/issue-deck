import {
  getClaudeApiUsageSummary,
  type ClaudeApiTotals,
  type ClaudeApiUsageSummary,
} from "@/lib/claude/api-usage";
import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * ops-dashboardの「アプリ別のAI利用」へ渡す、モデル別の共通の形（#3263）。
 *
 * 仕様の正はops-dashboardのREADME「アプリ別のAI利用」。**1行でも形が違うとops-dashboardは応答全体を
 * 採用せず「取得不可」と出す**ため、数値は常に有限の非負整数だけを返す。返すのは回数とトークン数
 * だけで、トークン・プロンプト本文・ユーザー入力は含めない。
 */
export type AiUsageWindow = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AiUsageFeature = {
  label: string;
  model: string;
  last24h: AiUsageWindow;
  last7d: AiUsageWindow;
};

export type AiUsageSummary = {
  features: AiUsageFeature[];
};

/**
 * ops-dashboardが使用量を読むための共有トークンを検証する。
 *
 * 値の正はops-dashboard側にあり、`/api/typesafe/usage`と同じ`OPS_API_TOKEN`を使う。
 */
export function authorizeAiUsage(authorizationHeader: string | null): SharedSecretAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.OPS_API_TOKEN);
}

function isOpenAiModel(model: string): boolean {
  return model.startsWith("gpt-");
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * 集計の値を公開用の形へ写す。
 *
 * 公開する`inputTokens`は**キャッシュに載らなかった分**。Anthropic・Jevは応答の`input_tokens`が
 * すでにその値だが、OpenAIの`input_tokens`は読み込み済みキャッシュ（`cached_tokens`）を含むため、
 * ここで差し引く（`request.ts`はOpenAIの値をそのまま計上しており、記録側では区別していない）。
 */
function toWindow(model: string, totals: ClaudeApiTotals): AiUsageWindow {
  const cacheRead = count(totals.cacheReadTokens);
  const input = count(totals.inputTokens);
  return {
    calls: count(totals.calls),
    inputTokens: isOpenAiModel(model) ? Math.max(0, input - cacheRead) : input,
    outputTokens: count(totals.outputTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: count(totals.cacheCreationTokens),
  };
}

/**
 * 機能×モデルごとの集計を、全提供元（Claude・OpenAI・Jev）のままモデル別1行で返す。
 *
 * 呼び出しが無ければ`features: []`。モデルIDが空の行は単価表へ寄せられないため出さない。
 */
export function summarizeAiUsage(summary: ClaudeApiUsageSummary): AiUsageSummary {
  const features: AiUsageFeature[] = [];
  for (const feature of summary.features) {
    for (const entry of feature.models) {
      if (!entry.model) continue;
      const last7d = toWindow(entry.model, entry.last7d);
      if (last7d.calls === 0) continue;
      features.push({
        label: feature.label,
        model: entry.model,
        last24h: toWindow(entry.model, entry.last24h),
        last7d,
      });
    }
  }
  return { features };
}

/** issue-deckが投げたAI APIの実測使用量を、現在保持している5分バケットから返す。 */
export function getAiUsageSummary(now: number = Date.now()): AiUsageSummary {
  return summarizeAiUsage(getClaudeApiUsageSummary(now));
}
