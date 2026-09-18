import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const sessionUsageFindMany = vi.fn();
const repositoryFindMany = vi.fn();
const issueFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchPullRequest = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    sessionUsage: {
      get findMany() {
        return sessionUsageFindMany;
      },
    },
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
    },
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

const fetchClaudeUsage = vi.fn();
vi.mock("@/lib/claude/usage", () => ({
  get fetchClaudeUsage() {
    return fetchClaudeUsage;
  },
}));
vi.mock("@/lib/dispatch/codex-usage", () => ({ getCodexUsage: vi.fn().mockResolvedValue(null) }));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/pull-requests-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/pull-requests-api")>();
  return {
    ...actual,
    get fetchPullRequest() {
      return fetchPullRequest;
    },
  };
});

import type { NextRequest } from "next/server";

import { GET } from "@/app/api/session-usage/route";

/**
 * 「Issue・PR別」一覧のタイトル解決（#2686）。**GitHub APIを呼ぶのはissueNumberを持たない
 * PR単体の行だけ**であることと、どちらの経路も失敗時に使用量本体を壊さないことを確かめる。
 */

function request(days = 7): NextRequest {
  const url = `http://localhost/api/session-usage?days=${days}`;
  return { url, nextUrl: new URL(url) } as unknown as NextRequest;
}

/** `SessionUsage`テーブルの1行。テストで動かす列だけ埋める */
function sessionUsageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "s1",
    agent: "claude",
    source: "local",
    host: "subpc",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 2686,
    prNumber: null,
    responses: 1,
    inputTokens: BigInt(100),
    cacheCreate5mTokens: BigInt(0),
    cacheCreate1hTokens: BigInt(0),
    cacheReadTokens: BigInt(0),
    outputTokens: BigInt(50),
    costUsd: 1,
    inputCostUsd: null,
    outputCostUsd: null,
    planCostUsd: null,
    implementationCostUsd: null,
    models: "[]",
    startedAt: new Date("2026-08-30T01:00:00.000Z"),
    endedAt: new Date("2026-08-30T02:00:00.000Z"),
    workflowName: null,
    runUrl: null,
    reportedAt: new Date("2026-08-30T02:05:00.000Z"),
    ...overrides,
  };
}

const ORIGINAL_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  // 集計は「今日を含むN日」で切るため（`sessionUsagePeriodStartMs`）、時計を止めないと
  // フィクスチャの日付（2026-08-30）が窓から外れた日に、変更が無くても落ちる。実際に
  // 日本時間2026-09-06 00:00を回った時点で3件とも落ちた（#2816で気付いた）
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T03:00:00.000Z"));
  requireUserId.mockResolvedValue("user-1");
  repositoryFindMany.mockResolvedValue([]);
  issueFindMany.mockResolvedValue([]);
  fetchClaudeUsage.mockResolvedValue(null);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
});

afterEach(() => {
  vi.useRealTimers();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_TOKEN;
});

describe("GET /api/session-usage", () => {
  it("issueNumberを持つ行は、DBのIssueテーブルからタイトルを引く（GitHub APIは呼ばない）", async () => {
    sessionUsageFindMany.mockResolvedValue([sessionUsageRow()]);
    repositoryFindMany.mockResolvedValue([
      { id: "repo-1", name: "issue-deck", ownerLogin: "guchi-apps", installation: { installationId: 1 } },
    ]);
    issueFindMany.mockResolvedValue([
      { repositoryId: "repo-1", number: 2686, title: "AI使用量画面にissue・PR別のタイトル表示機能を追加" },
    ]);

    const response = await GET(request());
    const body = await response.json();

    expect(body.byIssue).toHaveLength(1);
    expect(body.byIssue[0].title).toBe("AI使用量画面にissue・PR別のタイトル表示機能を追加");
    expect(fetchPullRequest).not.toHaveBeenCalled();
  });

  it("issueNumberを持たないPR単体の行だけ、GitHub APIでタイトルを取得する", async () => {
    sessionUsageFindMany.mockResolvedValue([
      sessionUsageRow({ sessionId: "pr", issueNumber: null, prNumber: 2691 }),
    ]);
    repositoryFindMany.mockResolvedValue([
      { id: "repo-1", name: "issue-deck", ownerLogin: "guchi-apps", installation: { installationId: 1 } },
    ]);
    getInstallationToken.mockResolvedValue("token-1");
    fetchPullRequest.mockResolvedValue({ title: "developへのPRレビュー" });

    const response = await GET(request());
    const body = await response.json();

    expect(fetchPullRequest).toHaveBeenCalledWith("guchi-apps", "issue-deck", 2691, "token-1");
    expect(body.byIssue[0].title).toBe("developへのPRレビュー");
  });

  it("タイトルの取得に失敗しても、使用量本体はそのまま返す", async () => {
    sessionUsageFindMany.mockResolvedValue([
      sessionUsageRow({ sessionId: "pr", issueNumber: null, prNumber: 2691 }),
    ]);
    repositoryFindMany.mockResolvedValue([
      { id: "repo-1", name: "issue-deck", ownerLogin: "guchi-apps", installation: { installationId: 1 } },
    ]);
    getInstallationToken.mockResolvedValue("token-1");
    fetchPullRequest.mockRejectedValue(new Error("404"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.byIssue[0].title).toBeNull();
    expect(body.byIssue[0].costUsd).toBe(1);
  });

  it("5時間枠の実測ヘッダが取れれば、換算レートとIssue別の枠%を計算して返す（#2988）", async () => {
    sessionUsageFindMany.mockResolvedValue([sessionUsageRow({ costUsd: 6 })]);
    fetchClaudeUsage.mockResolvedValue({
      windows: [
        {
          key: "5h",
          label: "5時間",
          usedPercent: 20,
          remainingPercent: 80,
          // NOW(03:00Z)の3時間後(06:00Z)にリセット → ウィンドウ開始は01:00Z。
          resetsAt: Date.parse("2026-08-30T06:00:00.000Z") / 1000,
          status: "allowed",
          durationMs: 5 * 60 * 60_000,
        },
      ],
      fetchedAt: Date.now(),
      stale: false,
    });

    const response = await GET(request());
    const body = await response.json();

    expect(body.quotaEstimate).toEqual({
      usdPerPercent: 6 / 20,
      windowStartMs: Date.parse("2026-08-30T01:00:00.000Z"),
      windowCostUsd: 6,
    });
    expect(body.byIssue[0].quotaPercent).toBe(20);
  });

  it("Claudeの使用量が取得できなければquotaEstimateはnull、Issueのquotaも全てnull", async () => {
    sessionUsageFindMany.mockResolvedValue([sessionUsageRow()]);
    fetchClaudeUsage.mockResolvedValue(null);

    const response = await GET(request());
    const body = await response.json();

    expect(body.quotaEstimate).toBeNull();
    expect(body.byIssue[0].quotaPercent).toBeNull();
  });

  it("5時間枠のウィンドウが期間の開始より前へはみ出す場合、取得範囲をウィンドウ開始まで広げる（#2988）", async () => {
    // 日本時間2026-08-31 02:10（UTC 17:10）に設定。「1日」の期間開始は日本時間の今日0:00
    // = UTC 2026-08-30T15:00:00.000Z。
    vi.setSystemTime(new Date("2026-08-30T17:10:00.000Z"));
    sessionUsageFindMany.mockResolvedValue([sessionUsageRow({ costUsd: 6 })]);
    fetchClaudeUsage.mockResolvedValue({
      windows: [
        {
          key: "5h",
          label: "5時間",
          usedPercent: 20,
          remainingPercent: 80,
          // リセットはUTC 18:00 → ウィンドウ開始は13:00Z。期間開始(15:00Z)より2時間早い。
          resetsAt: Date.parse("2026-08-30T18:00:00.000Z") / 1000,
          status: "allowed",
          durationMs: 5 * 60 * 60_000,
        },
      ],
      fetchedAt: Date.now(),
      stale: false,
    });

    const response = await GET(request(1));
    expect(response.status).toBe(200);

    // findManyへ渡された取得範囲が、期間の開始(15:00Z)ではなくウィンドウの開始(13:00Z)まで
    // 広がっていることを確かめる。
    const where = sessionUsageFindMany.mock.calls[0][0].where;
    expect(where.endedAt.gte.toISOString()).toBe("2026-08-30T13:00:00.000Z");
  });
});
