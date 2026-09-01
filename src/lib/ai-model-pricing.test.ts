import { describe, expect, it } from "vitest";

import {
  estimateCostUsd,
  estimateSessionCostUsd,
  formatCostUsd,
  resolveModelRate,
} from "@/lib/ai-model-pricing";

describe("resolveModelRate", () => {
  it("モデルIDが一致すればその単価を返す", () => {
    expect(resolveModelRate("claude-sonnet-5")).toEqual({
      input: 2.0,
      output: 10.0,
      cacheRead: 0.2,
    });
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

describe("estimateSessionCostUsd", () => {
  // 実測（SessionUsage・直近90日・実装619件）の平均トークンから割った金額。
  // Opus 5の値が記録済みの平均（$10.55）と一致することが、この定数が正しいことの根拠になる
  it("Opus 5は実測の平均（約$10.55）と一致する", () => {
    expect(estimateSessionCostUsd("claude-opus-5")).toBeCloseTo(10.55, 1);
  });

  // #2717の要点。単価はOpus 5の2倍なのに、金額は1.03倍にしかならない
  it("Fable 5.1はOpus 5の1.1倍以内に収まる（キャッシュ読み出しが半額のため）", () => {
    const fable = estimateSessionCostUsd("claude-fable-5-1");
    const opus = estimateSessionCostUsd("claude-opus-5");
    expect(fable).not.toBeNull();
    expect(opus).not.toBeNull();
    expect(fable! / opus!).toBeGreaterThan(1);
    expect(fable! / opus!).toBeLessThan(1.1);
  });

  it("Sonnet 5はOpus 5より安い", () => {
    expect(estimateSessionCostUsd("claude-sonnet-5")!).toBeLessThan(
      estimateSessionCostUsd("claude-opus-5")!,
    );
  });

  it("モデルを解決できない場合（auto）はnull", () => {
    expect(estimateSessionCostUsd(null)).toBeNull();
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
