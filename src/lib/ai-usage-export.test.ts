import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeApiTotals, ClaudeApiUsageSummary } from "@/lib/claude/api-usage";
import { authorizeAiUsage, summarizeAiUsage } from "@/lib/ai-usage-export";

function totals(
  calls: number,
  inputTokens: number,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): ClaudeApiTotals {
  return { calls, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function summary(features: ClaudeApiUsageSummary["features"]): ClaudeApiUsageSummary {
  return { measuringSince: 0, totalLast24h: totals(0, 0), totalLast7d: totals(0, 0), features };
}

describe("summarizeAiUsage", () => {
  it("呼び出しが無ければ空配列を返す", () => {
    expect(summarizeAiUsage(summary([]))).toEqual({ features: [] });
  });

  it("機能×モデルごとに1行で、Claude・OpenAI・Jevをすべて含める", () => {
    const result = summarizeAiUsage(
      summary([
        {
          key: "issue_summary",
          label: "Issueの要約",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [
            {
              model: "claude-opus-5",
              last24h: totals(2, 200, 20, 5, 7),
              last7d: totals(6, 600, 60, 15, 21),
            },
            { model: "gpt-5.6", last24h: totals(1, 100, 10), last7d: totals(3, 300, 30) },
          ],
        },
        {
          key: "model_pick",
          label: "モデルの自動選択",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [{ model: "jev-1.13.0", last24h: totals(4, 40), last7d: totals(8, 80) }],
        },
      ]),
    );

    expect(result.features).toEqual([
      {
        label: "Issueの要約",
        model: "claude-opus-5",
        last24h: { calls: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 },
        last7d: { calls: 6, inputTokens: 600, outputTokens: 60, cacheReadTokens: 15, cacheWriteTokens: 21 },
      },
      {
        label: "Issueの要約",
        model: "gpt-5.6",
        last24h: { calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        last7d: { calls: 3, inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        label: "モデルの自動選択",
        model: "jev-1.13.0",
        last24h: { calls: 4, inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        last7d: { calls: 8, inputTokens: 80, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("同じ機能でモデルを切り替えていれば2行に分ける", () => {
    const result = summarizeAiUsage(
      summary([
        {
          key: "issue_search",
          label: "AI検索",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [
            { model: "claude-haiku-4-5", last24h: totals(1, 10), last7d: totals(1, 10) },
            { model: "claude-opus-5", last24h: totals(0, 0), last7d: totals(2, 20) },
          ],
        },
      ]),
    );

    expect(result.features.map((row) => [row.label, row.model])).toEqual([
      ["AI検索", "claude-haiku-4-5"],
      ["AI検索", "claude-opus-5"],
    ]);
    expect(result.features[1].last24h.calls).toBe(0);
  });

  it("OpenAIのinputTokensからは読み込み済みキャッシュを差し引く（キャッシュに載らなかった分だけを返す）", () => {
    const result = summarizeAiUsage(
      summary([
        {
          key: "other",
          label: "その他",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [{ model: "gpt-5.6", last24h: totals(1, 1000, 50, 800), last7d: totals(1, 1000, 50, 800) }],
        },
      ]),
    );

    expect(result.features[0].last7d).toMatchObject({ inputTokens: 200, cacheReadTokens: 800 });
  });

  it("モデルIDが空の行と、7日間の呼び出しが無い行は出さない", () => {
    const result = summarizeAiUsage(
      summary([
        {
          key: "other",
          label: "その他",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [
            { model: "", last24h: totals(1, 1), last7d: totals(1, 1) },
            { model: "claude-opus-5", last24h: totals(0, 0), last7d: totals(0, 0) },
          ],
        },
      ]),
    );

    expect(result.features).toEqual([]);
  });

  it("応答の数値は常に有限の非負整数にする", () => {
    const result = summarizeAiUsage(
      summary([
        {
          key: "other",
          label: "その他",
          last24h: totals(0, 0),
          last7d: totals(0, 0),
          models: [
            {
              model: "claude-opus-5",
              last24h: totals(1, Number.NaN, -3, Number.POSITIVE_INFINITY, 1.4),
              last7d: totals(1, 1, 1, 1, 1),
            },
          ],
        },
      ]),
    );

    expect(result.features[0].last24h).toEqual({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
    });
  });
});

describe("authorizeAiUsage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("OPS_API_TOKENと一致するBearerだけを通す", () => {
    vi.stubEnv("OPS_API_TOKEN", "expected-token");

    expect(authorizeAiUsage("Bearer expected-token")).toBe("ok");
    expect(authorizeAiUsage("Bearer incorrect")).toBe("unauthorized");
    expect(authorizeAiUsage(null)).toBe("unauthorized");
  });

  it("OPS_API_TOKENが空なら設定漏れとして区別する", () => {
    vi.stubEnv("OPS_API_TOKEN", "");

    expect(authorizeAiUsage("Bearer anything")).toBe("not_configured");
  });
});
