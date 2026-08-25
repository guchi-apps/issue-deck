import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ClaudeApiTokens,
  type ClaudeApiUsageBucketSnapshot,
  getClaudeApiUsageSummary,
  loadPersistedBuckets,
  onBucketUpdated,
  recordClaudeApiCall,
  resetClaudeApiUsage,
  totalTokens,
  USAGE_WINDOW_MS,
} from "@/lib/claude/api-usage";

const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();
const MODEL = "claude-haiku-4-5";

function tokens(overrides: Partial<ClaudeApiTokens> = {}): ClaudeApiTokens {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe("claudeApiUsage", () => {
  beforeEach(() => {
    resetClaudeApiUsage();
  });

  it("機能別・モデル別に呼び出し回数とトークン数を集計する", () => {
    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });
    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });
    recordClaudeApiCall({
      feature: "issue_search",
      model: "claude-sonnet-5",
      tokens: tokens({ inputTokens: 10, outputTokens: 5 }),
      now: NOW,
    });

    const summary = getClaudeApiUsageSummary(NOW);

    expect(summary.totalLast24h.calls).toBe(3);
    expect(totalTokens(summary.totalLast24h)).toBe(255);
    expect(summary.features.map((feature) => feature.key)).toEqual([
      "issue_summary",
      "issue_search",
    ]);
    expect(summary.features[0].label).toBe("Issueの要約");
    expect(summary.features[0].last24h.calls).toBe(2);
    expect(summary.features[0].models).toEqual([
      {
        model: MODEL,
        last24h: {
          calls: 2,
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        last7d: {
          calls: 2,
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ]);
  });

  it("トークン数にはキャッシュの読み書きも含める", () => {
    recordClaudeApiCall({
      feature: "new_app_consult",
      model: MODEL,
      tokens: tokens({ cacheReadTokens: 1_000, cacheCreationTokens: 500 }),
      now: NOW,
    });

    expect(totalTokens(getClaudeApiUsageSummary(NOW).totalLast24h)).toBe(1_620);
  });

  it("過去1日と過去7日を分けて数える", () => {
    // 3日前の呼び出しは「過去7日」には入るが「過去1日」には入らない。
    recordClaudeApiCall({
      feature: "issue_summary",
      model: MODEL,
      tokens: tokens(),
      now: NOW - 3 * 24 * 60 * 60_000,
    });
    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });

    const summary = getClaudeApiUsageSummary(NOW);

    expect(summary.totalLast24h.calls).toBe(1);
    expect(summary.totalLast7d.calls).toBe(2);
  });

  it("保持期間（7日）より古いバケットは捨てる", () => {
    recordClaudeApiCall({
      feature: "issue_summary",
      model: MODEL,
      tokens: tokens(),
      now: NOW - USAGE_WINDOW_MS - 60_000,
    });
    recordClaudeApiCall({ feature: "issue_search", model: MODEL, tokens: tokens(), now: NOW });

    const summary = getClaudeApiUsageSummary(NOW);

    expect(summary.features.map((feature) => feature.key)).toEqual(["issue_search"]);
    expect(summary.totalLast24h.calls).toBe(1);
  });

  it("呼び出しのたびに、そのバケットの現在の中身をリスナーへ渡す（繰り上がりを待たない）", () => {
    const listener = vi.fn();
    onBucketUpdated(listener);

    // 1件目で即座に渡る。**繰り上がりを待つと、次の呼び出しまで数時間空くAIの使い方では
    // 直近の消費が保存されないまま消える。**
    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });
    expect(listener).toHaveBeenCalledTimes(1);

    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });
    expect(listener).toHaveBeenCalledTimes(2);

    const updated = listener.mock.calls[1][0] as ClaudeApiUsageBucketSnapshot;
    expect(updated.startedAt).toBe(NOW);
    expect(updated.entries).toEqual([
      {
        feature: "issue_summary",
        model: MODEL,
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
  });

  it("DBから復元したバケットはメモリ上の集計へ加算する", () => {
    recordClaudeApiCall({ feature: "issue_summary", model: MODEL, tokens: tokens(), now: NOW });
    loadPersistedBuckets(
      [
        {
          startedAt: NOW,
          entries: [
            {
              feature: "issue_summary",
              model: MODEL,
              calls: 3,
              inputTokens: 300,
              outputTokens: 60,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          ],
        },
      ],
      NOW,
    );

    const summary = getClaudeApiUsageSummary(NOW);

    expect(summary.totalLast24h.calls).toBe(4);
    expect(summary.totalLast24h.inputTokens).toBe(400);
  });
});
