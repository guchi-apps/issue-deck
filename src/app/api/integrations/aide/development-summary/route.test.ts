import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const load = vi.fn();
const findUserByLogin = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    sharedToken: { findUnique: vi.fn().mockResolvedValue(null) },
    sharedTokenUsage: { create: vi.fn() },
    user: {
      get findUnique() {
        return findUserByLogin;
      },
    },
  },
}));
vi.mock("@/lib/aide-development-summary-load", () => ({
  get loadDevelopmentSummary() {
    return load;
  },
  SYNC_STALE_AFTER_MS: 1,
}));

import { clearSharedTokenReaderCache } from "@/lib/shared-token-reader";

const { GET } = await import("./route");

function request(query = "", authorization?: string) {
  return new NextRequest(`http://localhost/api/integrations/aide/development-summary${query}`, {
    headers: authorization ? { authorization } : {},
  });
}

const emptySummary = {
  population: {},
  totals: { marker: 1 },
  byRepository: {},
  items: {
    notStarted: [], inProgress: [], reserved: [], checkUser: [], manualStep: [],
    problems: [], pullRequests: [], deployment: [], recentCompletions: [],
  },
  reservation: {},
  pullRequestsAvailable: true,
  recentCompletions: { from: "f", to: "t", historyComplete: true, historyNote: null },
  overlapNotes: [],
  warnings: [],
};

describe("GET /api/integrations/aide/development-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSharedTokenReaderCache();
    process.env.AIDE_SUMMARY_SECRET = "aide-secret";
    process.env.AIDE_SUMMARY_USER_LOGIN = "owner";
    findUserByLogin.mockResolvedValue({ id: "u1", githubLogin: "owner" });
    load.mockResolvedValue({
      summary: emptySummary,
      source: { generatedAt: "2026-10-05T00:00:00.000Z", sourceUpdatedAt: null, stale: false, staleRepositories: [], unavailable: [], complete: true },
    });
  });

  it("鍵が未設定なら503で、集計を読まない", async () => {
    delete process.env.AIDE_SUMMARY_SECRET;
    clearSharedTokenReaderCache();

    const res = await GET(request("", "Bearer x"));

    expect(res.status).toBe(503);
    expect(load).not.toHaveBeenCalled();
  });

  it("Authorizationが無い・値が違うなら401で、集計を読まない", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("", "Bearer wrong"))).status).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it("対象利用者が未設定なら503", async () => {
    delete process.env.AIDE_SUMMARY_USER_LOGIN;
    clearSharedTokenReaderCache();

    const res = await GET(request("", "Bearer aide-secret"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "user_not_configured" });
  });

  it("利用者は呼び出し引数ではなく設定で決まる", async () => {
    const res = await GET(request("?userId=attacker&userLogin=attacker", "Bearer aide-secret"));

    expect(res.status).toBe(200);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", userLogin: "owner" }));
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.scope.userLogin).toBe("owner");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("不正なクエリは400で、集計を読まない", async () => {
    const res = await GET(request("?category=bogus", "Bearer aide-secret"));

    expect(res.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it("母集団に無いリポジトリは404", async () => {
    const res = await GET(request("?repositoryFullName=o/none", "Bearer aide-secret"));

    expect(res.status).toBe(404);
  });

  it("集計の取得が失敗したら500（内容は返さない）", async () => {
    load.mockRejectedValue(new Error("secret detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(request("", "Bearer aide-secret"));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});
