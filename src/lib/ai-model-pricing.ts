/**
 * モデル別の単価と、トークン数からの概算コスト（#2717）。
 *
 * **金額はAPI換算の目安で、サブスクの実費ではない。** 表示側で必ずその旨を断る
 * （`session-usage-view.ts`が既に同じ断りを持っている）。
 *
 * **同じ単価表が`scripts/lib/session-usage.sh`にもある。** 数える対象が違う
 * （あちらはClaude Codeの転記、こちらはissue-deck自身のAPI呼び出しと画面の見積り）ので
 * 統合はしないが、**料金が変わったら両方を直す**。
 *
 * キャッシュの扱いに注意する。読み出しは多くのモデルで入力単価の0.1倍だが、
 * **Claude Fable 5.1だけ$0.25/MTok（入力の0.025倍）**で、ここを0.1倍で数えると
 * 長いセッションの金額が2倍に膨らむ。だから倍率ではなく**単価そのもの**を持つ。
 */

/** 100万トークンあたりの単価（USD） */
export type ModelRate = {
  input: number;
  output: number;
  /** キャッシュ読み出し。**倍率ではなく単価**（モデルごとに倍率が違うため） */
  cacheRead: number;
};

/** キャッシュ書き込みの倍率（入力単価に対して）。TTLで違う */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * モデルID → 単価。claude-apiスキルの料金表（2026-08時点）とOpenAIの料金表による。
 *
 * 日付サフィックス付きのID（`claude-haiku-4-5-20251001`）は前方一致で拾う（`resolveModelRate`）。
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25 },
  "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0 },
  "claude-mythos-5": { input: 10.0, output: 50.0, cacheRead: 1.0 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1 },
  "gpt-5.6-sol": { input: 4.0, output: 20.0, cacheRead: 0.4 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0, cacheRead: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
  "gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5 },
  "gpt-5.4": { input: 2.5, output: 15.0, cacheRead: 0.25 },
};

/**
 * モデルIDから単価を引く。**知らないモデルは`null`**（表示側は金額を出さない）。
 *
 * 日付サフィックス付き（`claude-haiku-4-5-20251001`）は前方一致で拾い、
 * **いちばん長く一致した行を採る**——`claude-fable-5-1`を`claude-fable-5`として
 * 数えないための決まりで、`scripts/lib/session-usage.sh`の`price_for`と同じ作法。
 */
export function resolveModelRate(model: string | null | undefined): ModelRate | null {
  if (!model) return null;
  const exact = MODEL_RATES[model];
  if (exact) return exact;

  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_RATES)) {
    if (!model.startsWith(`${key}-`)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === null ? null : MODEL_RATES[bestKey];
}

/** 概算コストの入力。`usage`が返す実測のトークン数をそのまま渡す */
export type ModelTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** キャッシュ書き込み。TTLの内訳が無いので5分TTL（1.25倍）として数える */
  cacheCreationTokens: number;
};

/**
 * トークン数からAPI換算の金額（USD）を出す。**知らないモデルは`null`。**
 *
 * キャッシュ書き込みのTTLを区別できる呼び出し元（セッションの見積り）は
 * `estimateSessionCostUsd`を使う。
 */
export function estimateCostUsd(
  model: string | null | undefined,
  tokens: ModelTokenCounts,
): number | null {
  const rate = resolveModelRate(model);
  if (!rate) return null;
  return (
    (tokens.inputTokens * rate.input +
      tokens.cacheCreationTokens * rate.input * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cacheReadTokens * rate.cacheRead +
      tokens.outputTokens * rate.output) /
    1_000_000
  );
}

/**
 * サブPCの実装セッション1件あたりの平均トークン数（#2717）。
 *
 * **実測値**（`SessionUsage`の直近90日・`kind='implementation'`・619件、2026-09-01時点）。
 * この平均にOpus 5の単価を掛けた金額は、記録済みの合計（$6,532）と一致することを確かめてある。
 *
 * 起動時のモデル選択に「1件あたりの目安」を出すためだけに持つ定数で、**古くなっても
 * 表示が桁で外れるだけ**（判定や課金には使わない）。次のSQLで測り直せる。
 *
 * ```sql
 * SELECT AVG(inputTokens), AVG(cacheCreate5mTokens), AVG(cacheCreate1hTokens),
 *        AVG(cacheReadTokens), AVG(outputTokens)
 *   FROM SessionUsage
 *  WHERE kind = 'implementation' AND endedAt > NOW() - INTERVAL 90 DAY;
 * ```
 *
 * **キャッシュ読み出しが桁違いに大きい**のがこの数字の要点で、モデル間の金額差が
 * 素の単価比（Fable 5.1はOpus 5の2倍）どおりにならない理由もここにある。
 */
export const AVERAGE_IMPLEMENTATION_SESSION_TOKENS = {
  inputTokens: 164,
  cacheCreate5mTokens: 739,
  cacheCreate1hTokens: 234_496,
  cacheReadTokens: 13_584_854,
  outputTokens: 56_414,
} as const;

/**
 * 実装セッション1件あたりの目安（USD）。**知らないモデルは`null`。**
 * キャッシュ書き込みはTTLごとの倍率で分けて数える。
 */
export function estimateSessionCostUsd(model: string | null | undefined): number | null {
  const rate = resolveModelRate(model);
  if (!rate) return null;
  const t = AVERAGE_IMPLEMENTATION_SESSION_TOKENS;
  return (
    (t.inputTokens * rate.input +
      t.cacheCreate5mTokens * rate.input * CACHE_WRITE_5M_MULTIPLIER +
      t.cacheCreate1hTokens * rate.input * CACHE_WRITE_1H_MULTIPLIER +
      t.cacheReadTokens * rate.cacheRead +
      t.outputTokens * rate.output) /
    1_000_000
  );
}

/**
 * 画面に出す金額の書き方。**小さすぎて`$0.00`になる額は桁を増やす**——
 * アプリ内AIの1回は数セントで、2桁だと全部`$0.00`になり比較にならない。
 */
export function formatCostUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
