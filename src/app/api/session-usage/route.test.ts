import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/claude/usage", () => ({ fetchClaudeUsage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/dispatch/codex-usage", () => ({ getLatestCodexUsage: vi.fn().mockResolvedValue(null) }));

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

function request(): NextRequest {
  return { url: "http://localhost/api/session-usage?days=7", nextUrl: new URL("http://localhost/api/session-usage?days=7") } as unknown as NextRequest;
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

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  repositoryFindMany.mockResolvedValue([]);
  issueFindMany.mockResolvedValue([]);
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
});
