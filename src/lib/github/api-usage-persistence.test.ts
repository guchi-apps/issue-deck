import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushBucketToDb, hydrateGithubApiUsageFromDb } from "@/lib/github/api-usage-persistence";
import { getGithubApiUsageSummary, resetGithubApiUsage, USAGE_WINDOW_MS } from "@/lib/github/api-usage";

const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
const $transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    githubApiUsageBucket: {
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

describe("hydrateGithubApiUsageFromDb", () => {
  beforeEach(() => {
    resetGithubApiUsage();
    findMany.mockReset();
  });

  it("DBの行を用途・エンドポイントごとにバケットへ復元する", async () => {
    findMany.mockResolvedValue([
      { startedAt: new Date(NOW - 60 * 60_000), feature: "sync", endpoint: "/repos/{owner}/{repo}", count: 2 },
      { startedAt: new Date(NOW - 60 * 60_000), feature: "issue_comments", endpoint: "/issues/{n}", count: 1 },
    ]);

    await hydrateGithubApiUsageFromDb(NOW);

    const summary = getGithubApiUsageSummary(NOW);
    expect(summary.totalLast24h).toBe(3);
    expect(summary.measuringSince).toBe(NOW - 60 * 60_000);
    expect(findMany).toHaveBeenCalledWith({
      where: { startedAt: { gte: new Date(NOW - USAGE_WINDOW_MS) } },
    });
  });

  it("DB接続に失敗してもthrowせず、メモリ空のまま継続する", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValue(new Error("connection refused"));

    await expect(hydrateGithubApiUsageFromDb(NOW)).resolves.toBeUndefined();
    expect(getGithubApiUsageSummary(NOW).totalLast24h).toBe(0);
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
          { feature: "sync", endpoint: "/repos/{owner}/{repo}", count: 2 },
          { feature: "issue_comments", endpoint: "/issues/{n}", count: 1 },
        ],
      },
      NOW,
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        startedAt_feature_endpoint: { startedAt: new Date(NOW), feature: "sync", endpoint: "/repos/{owner}/{repo}" },
      },
      create: { startedAt: new Date(NOW), feature: "sync", endpoint: "/repos/{owner}/{repo}", count: 2 },
      update: { count: 2 },
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
      flushBucketToDb({ startedAt: NOW, entries: [{ feature: "sync", endpoint: "/x", count: 1 }] }, NOW),
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
