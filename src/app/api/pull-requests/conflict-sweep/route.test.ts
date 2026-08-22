import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runConflictSweep = vi.fn();

vi.mock("@/lib/github/conflict-sweep-run", () => ({
  get runConflictSweep() {
    return runConflictSweep;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/pull-requests/conflict-sweep/route";

function request(body: unknown, authorization?: string): NextRequest {
  return {
    headers: new Headers(authorization === undefined ? {} : { Authorization: authorization }),
    json: async () => body,
  } as unknown as NextRequest;
}

const RESULT = {
  swept: true,
  disabled: false,
  repositories: 3,
  conflicting: 1,
  dispatched: [
    { repositoryFullName: "guchi-apps/myroom", pullRequestNumber: 191, issueNumber: "109" },
  ],
  skipped: {},
  failedRepositories: [],
};

describe("POST /api/pull-requests/conflict-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_SECRET = "secret";
    delete process.env.PREVIEW_MODE;
    runConflictSweep.mockResolvedValue(RESULT);
  });

  afterEach(() => {
    delete process.env.DISPATCH_SECRET;
    delete process.env.PREVIEW_MODE;
  });

  it("共有シークレットが一致すれば巡回して結果を返す", async () => {
    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, dispatched: RESULT.dispatched });
    expect(runConflictSweep).toHaveBeenCalledWith({ force: false });
  });

  it("forceを渡すと間隔を無視して巡回する", async () => {
    await POST(request({ force: true }, "Bearer secret"));

    expect(runConflictSweep).toHaveBeenCalledWith({ force: true });
  });

  it("シークレットが一致しなければ401で巡回しない", async () => {
    const response = await POST(request({}, "Bearer wrong"));

    expect(response.status).toBe(401);
    expect(runConflictSweep).not.toHaveBeenCalled();
  });

  it("issue-deck側でDISPATCH_SECRETが未設定なら503（設定漏れと値の不一致を分ける）", async () => {
    delete process.env.DISPATCH_SECRET;

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(503);
    expect(runConflictSweep).not.toHaveBeenCalled();
  });

  it("プレビュー環境では403で封じる（worktreeの開発サーバーから本番のワークフローを起動しない）", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(403);
    expect(runConflictSweep).not.toHaveBeenCalled();
  });

  it("巡回が落ちても500を返すだけで、pollerの1巡は止めない", async () => {
    runConflictSweep.mockRejectedValue(new Error("boom"));

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "sweep_failed" });
  });
});
