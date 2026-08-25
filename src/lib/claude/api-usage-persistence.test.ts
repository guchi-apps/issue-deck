import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getClaudeApiUsageSummary,
  resetClaudeApiUsage,
  USAGE_WINDOW_MS,
} from "@/lib/claude/api-usage";
import { flushBucketToDb, hydrateClaudeApiUsageFromDb } from "@/lib/claude/api-usage-persistence";

const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
const $transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    claudeApiUsageBucket: {
      get findMany() {
        return findMany;
      },
      get upsert() {
        return upsert;
      },
      get deleteMany() {
        return deleteMany;
      },
    },
    get $transaction() {
      return $transaction;
    },
  },
}));

const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();

function row(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: new Date(NOW - 60 * 60_000),
    feature: "issue_summary",
    model: "claude-haiku-4-5",
    calls: 2,
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe("hydrateClaudeApiUsageFromDb", () => {
  beforeEach(() => {
    resetClaudeApiUsage();
    findMany.mockReset();
  });

  it("DBの行を機能・モデルごとにバケットへ復元する", async () => {
    findMany.mockResolvedValue([
      row(),
      row({ feature: "issue_search", calls: 1, inputTokens: 100, outputTokens: 10 }),
    ]);

    await hydrateClaudeApiUsageFromDb(NOW);

    const summary = getClaudeApiUsageSummary(NOW);
    expect(summary.totalLast24h.calls).toBe(3);
    expect(summary.totalLast24h.inputTokens).toBe(300);
    expect(summary.measuringSince).toBe(NOW - 60 * 60_000);
    expect(findMany).toHaveBeenCalledWith({
      where: { startedAt: { gte: new Date(NOW - USAGE_WINDOW_MS) } },
    });
  });

  it("DB接続に失敗してもthrowせず、メモリ空のまま継続する", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValue(new Error("connection refused"));

    await expect(hydrateClaudeApiUsageFromDb(NOW)).resolves.toBeUndefined();
    expect(getClaudeApiUsageSummary(NOW).totalLast24h.calls).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe("flushBucketToDb", () => {
  beforeEach(() => {
    $transaction.mockReset();
    upsert.mockReset();
    deleteMany.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("バケット内のエントリをupsertし、古い行を削除するトランザクションを発行する", async () => {
    $transaction.mockResolvedValue(undefined);

    await flushBucketToDb(
      {
        startedAt: NOW,
        entries: [
          {
            feature: "issue_summary",
            model: "claude-haiku-4-5",
            calls: 2,
            inputTokens: 200,
            outputTokens: 40,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
          },
        ],
      },
      NOW,
    );

    expect(upsert).toHaveBeenCalledWith({
      where: {
        startedAt_feature_model: {
          startedAt: new Date(NOW),
          feature: "issue_summary",
          model: "claude-haiku-4-5",
        },
      },
      create: {
        startedAt: new Date(NOW),
        feature: "issue_summary",
        model: "claude-haiku-4-5",
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
      },
      update: {
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
      },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: new Date(NOW - USAGE_WINDOW_MS) } },
    });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("DB書き込みに失敗してもthrowしない", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    $transaction.mockRejectedValue(new Error("connection refused"));

    await expect(
      flushBucketToDb(
        {
          startedAt: NOW,
          entries: [
            {
              feature: "issue_summary",
              model: "claude-haiku-4-5",
              calls: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          ],
        },
        NOW,
      ),
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
