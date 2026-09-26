import { describe, expect, it } from "vitest";

import type { ClaudeApiUsageSummary } from "@/lib/claude/api-usage";
import { isJevModel, summarizeTypeSafeUsage } from "@/lib/typesafe/usage";

function totals(calls: number, inputTokens: number) {
  return { calls, inputTokens, outputTokens: 99, cacheReadTokens: 88, cacheCreationTokens: 77 };
}

const source: ClaudeApiUsageSummary = {
  measuringSince: 0,
  totalLast24h: totals(10, 1_000),
  totalLast7d: totals(20, 2_000),
  features: [
    {
      key: "model_pick",
      label: "モデルの自動選択",
      last24h: totals(5, 500),
      last7d: totals(10, 1_000),
      models: [
        { model: "jev-1.13.0", last24h: totals(2, 200), last7d: totals(4, 400) },
        { model: "claude-haiku-4-5", last24h: totals(3, 300), last7d: totals(6, 600) },
      ],
    },
    {
      key: "issue_summary",
      label: "Issueの要約",
      last24h: totals(5, 500),
      last7d: totals(10, 1_000),
      models: [
        { model: "JEV-latest", last24h: totals(1, 100), last7d: totals(2, 200) },
        { model: "gpt-5.6", last24h: totals(4, 400), last7d: totals(8, 800) },
      ],
    },
  ],
};

describe("summarizeTypeSafeUsage", () => {
  it("Jevだけを用途別・期間別に集計し、他提供元のトークン種別を返さない", () => {
    expect(summarizeTypeSafeUsage(source)).toEqual({
      last24h: { calls: 3, inputTokens: 300 },
      last7d: { calls: 6, inputTokens: 600 },
      features: [
        {
          key: "model_pick",
          label: "モデルの自動選択",
          last24h: { calls: 2, inputTokens: 200 },
          last7d: { calls: 4, inputTokens: 400 },
        },
        {
          key: "issue_summary",
          label: "Issueの要約",
          last24h: { calls: 1, inputTokens: 100 },
          last7d: { calls: 2, inputTokens: 200 },
        },
      ],
    });
  });

  it("issue_suggestはJevの担当範囲に合わせて「ラベルの選択」と表示する", () => {
    const suggest: ClaudeApiUsageSummary = {
      ...source,
      features: [
        {
          key: "issue_suggest",
          label: "Issueの下書き提案",
          last24h: totals(1, 100),
          last7d: totals(1, 100),
          models: [{ model: "jev-1.13.0", last24h: totals(1, 100), last7d: totals(1, 100) }],
        },
      ],
    };
    expect(summarizeTypeSafeUsage(suggest).features[0].label).toBe("ラベルの選択");
  });

  it("Jevの記録が無ければゼロ値と空の内訳を返す", () => {
    const noJev = {
      ...source,
      features: [{ ...source.features[0], models: [source.features[0].models[1]] }],
    };
    expect(summarizeTypeSafeUsage(noJev)).toEqual({
      last24h: { calls: 0, inputTokens: 0 },
      last7d: { calls: 0, inputTokens: 0 },
      features: [],
    });
  });
});

describe("isJevModel", () => {
  it.each(["jev", "jev-latest", "JEV-1.13.0"])("%sをJevとして扱う", (model) => {
    expect(isJevModel(model)).toBe(true);
  });

  it.each(["claude-haiku-4-5", "gpt-5.6", "not-jev"])("%sを除外する", (model) => {
    expect(isJevModel(model)).toBe(false);
  });
});
