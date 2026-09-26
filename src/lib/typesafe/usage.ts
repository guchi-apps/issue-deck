import {
  getClaudeApiUsageSummary,
  type ClaudeApiFeature,
  type ClaudeApiTotals,
  type ClaudeApiUsageSummary,
} from "@/lib/claude/api-usage";

/** ops-dashboardへ公開するJevの使用量は、呼出回数と入力トークン数だけに限定する。 */
export type TypeSafeUsageTotals = {
  calls: number;
  inputTokens: number;
};

export type TypeSafeUsageFeature = {
  key: ClaudeApiFeature;
  label: string;
  last24h: TypeSafeUsageTotals;
  last7d: TypeSafeUsageTotals;
};

export type TypeSafeUsageSummary = {
  last24h: TypeSafeUsageTotals;
  last7d: TypeSafeUsageTotals;
  features: TypeSafeUsageFeature[];
};

/**
 * Jevが実際に担当している範囲を表すラベル。`CLAUDE_API_FEATURES`の表示名はアプリ内AI側の
 * 機能全体を指すため、Jevの担当が一部だけの機能はここで上書きする（無ければ既存ラベル）。
 * `issue_suggest`のうちJevが担当するのはラベル判定のみ（#3245）。
 */
const JEV_FEATURE_LABELS: Partial<Record<ClaudeApiFeature, string>> = {
  issue_suggest: "ラベルの選択",
};

function emptyTotals(): TypeSafeUsageTotals {
  return { calls: 0, inputTokens: 0 };
}

function addTotals(
  target: TypeSafeUsageTotals,
  source: Pick<ClaudeApiTotals, "calls" | "inputTokens">,
): void {
  target.calls += source.calls;
  target.inputTokens += source.inputTokens;
}

/** TypeSafe System Oneの実体モデル名。Claude/OpenAIの同居するバケットを公開しないために使う。 */
export function isJevModel(model: string): boolean {
  return /^jev(?:-|$)/i.test(model);
}

/**
 * 既存のアプリ内AI集計からJevだけを公開用の最小形式へ変換する。
 *
 * 同じバケットにはClaude/OpenAIの使用量も入るため、機能全体の合計を再利用せず、モデルごとの値を
 * Jevに限って足し直す。金額・出力トークン・キャッシュトークンはops-dashboardへ渡さない。
 */
export function summarizeTypeSafeUsage(summary: ClaudeApiUsageSummary): TypeSafeUsageSummary {
  const last24h = emptyTotals();
  const last7d = emptyTotals();
  const features: TypeSafeUsageFeature[] = [];

  for (const feature of summary.features) {
    const featureLast24h = emptyTotals();
    const featureLast7d = emptyTotals();

    for (const model of feature.models) {
      if (!isJevModel(model.model)) continue;
      addTotals(featureLast24h, model.last24h);
      addTotals(featureLast7d, model.last7d);
    }

    if (featureLast7d.calls === 0 && featureLast7d.inputTokens === 0) continue;
    addTotals(last24h, featureLast24h);
    addTotals(last7d, featureLast7d);
    features.push({
      key: feature.key,
      label: JEV_FEATURE_LABELS[feature.key] ?? feature.label,
      last24h: featureLast24h,
      last7d: featureLast7d,
    });
  }

  return { last24h, last7d, features };
}

/** TypeSafe Jevの実測使用量を、現在保持している5分バケットから返す。 */
export function getTypeSafeUsageSummary(now: number = Date.now()): TypeSafeUsageSummary {
  return summarizeTypeSafeUsage(getClaudeApiUsageSummary(now));
}
