import { describe, expect, it } from "vitest";

import { estimateCostUsd, formatCostUsd, resolveModelRate } from "@/lib/ai-model-pricing";
import { APP_AI_MODEL_OPTIONS, CLAUDE_ALIAS_MODEL_IDS } from "@/lib/app-settings";

describe("resolveModelRate", () => {
  it("モデルIDが一致すればその単価を返す", () => {
    expect(resolveModelRate("claude-sonnet-5")).toEqual({
      input: 2.0,
      output: 10.0,
      cacheRead: 0.2,
    });
  });

  it("GPT-6 Astraの単価を返す", () => {
    expect(resolveModelRate("gpt-6-astra")).toEqual({
      input: 10.0,
      output: 50.0,
      cacheRead: 1.0,
    });
  });

  it("GPT-6 SolとLunaの単価を返す", () => {
    expect(resolveModelRate("gpt-6-sol")).toEqual({ input: 2.0, output: 10.0, cacheRead: 0.2 });
    expect(resolveModelRate("gpt-6-luna")).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 });
  });

  it("日付サフィックス付きは前方一致で拾う", () => {
    expect(resolveModelRate("claude-haiku-4-5-20251001")).toEqual({
      input: 1.0,
      output: 5.0,
      cacheRead: 0.1,
    });
  });

  // #2717。ここを取り違えると、長いセッションの金額がキャッシュ読み出しのぶんだけ4倍に膨らむ
  it("Fable 5.1をFable 5の単価で拾わない（キャッシュ読み出しが4倍違う）", () => {
    expect(resolveModelRate("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(resolveModelRate("claude-fable-5")?.cacheRead).toBe(1.0);
  });

  it("知らないモデル・空の値はnull（画面は金額を出さない）", () => {
    expect(resolveModelRate("gemini-3")).toBeNull();
    expect(resolveModelRate("")).toBeNull();
    expect(resolveModelRate(null)).toBeNull();
  });

  // #3374。取り違えると、Opus 5.5のセッションがOpus 5の単価（2割ほど高い）で計算されてしまう
  it("Opus 5.5をOpus 5の単価で拾わない", () => {
    expect(resolveModelRate("claude-opus-5-5")).toEqual({
      input: 4.0,
      output: 20.0,
      cacheRead: 0.2,
    });
    expect(resolveModelRate("claude-opus-5")).toEqual({
      input: 5.0,
      output: 25.0,
      cacheRead: 0.5,
    });
  });

  // #3374。選択肢に載っているのに単価表への追加を忘れると、画面の金額が黙って空欄になる
  it("選択できるモデルは全て単価表にある", () => {
    const modelIds = [
      ...APP_AI_MODEL_OPTIONS.map((option) => option.value),
      ...Object.values(CLAUDE_ALIAS_MODEL_IDS),
    ];
    for (const modelId of modelIds) {
      expect(resolveModelRate(modelId), `${modelId}の単価が見つからない`).not.toBeNull();
    }
  });
});

describe("estimateCostUsd", () => {
  it("入力・出力・キャッシュを単価どおりに足す", () => {
    // 入力100万・出力100万・キャッシュ読み100万・書き込み100万 = 2 + 10 + 0.2 + 2*1.25
    expect(
      estimateCostUsd("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      }),
    ).toBeCloseTo(14.7, 6);
  });

  it("知らないモデルはnull", () => {
    expect(
      estimateCostUsd("gpt-4o", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("formatCostUsd", () => {
  it("数セントの額でも0にならない桁で出す", () => {
    expect(formatCostUsd(0.0032)).toBe("$0.0032");
    expect(formatCostUsd(0.125)).toBe("$0.125");
    expect(formatCostUsd(10.92)).toBe("$10.92");
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  it("金額が無ければnull", () => {
    expect(formatCostUsd(null)).toBeNull();
    expect(formatCostUsd(Number.NaN)).toBeNull();
  });
});
