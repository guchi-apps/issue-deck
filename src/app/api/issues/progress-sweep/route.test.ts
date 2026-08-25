import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runProgressSweep = vi.fn();

vi.mock("@/lib/github/progress-sweep-run", () => ({
  get runProgressSweep() {
    return runProgressSweep;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/issues/progress-sweep/route";

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
  candidates: 2,
  actions: [
    { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 2294, kind: "advanced" as const },
  ],
  skipped: {},
  failedRepositories: [],
};

describe("POST /api/issues/progress-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISPATCH_SECRET = "secret";
    delete process.env.PREVIEW_MODE;
    runProgressSweep.mockResolvedValue(RESULT);
  });

  afterEach(() => {
    delete process.env.DISPATCH_SECRET;
    delete process.env.PREVIEW_MODE;
  });

  it("共有シークレットが一致すれば巡回して結果を返す", async () => {
    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, actions: RESULT.actions });
    expect(runProgressSweep).toHaveBeenCalledWith({ force: false });
  });

  it("forceを渡すと間隔を無視して巡回する", async () => {
    await POST(request({ force: true }, "Bearer secret"));

    expect(runProgressSweep).toHaveBeenCalledWith({ force: true });
  });

  it("シークレットが一致しなければ401で巡回しない", async () => {
    const response = await POST(request({}, "Bearer wrong"));

    expect(response.status).toBe(401);
    expect(runProgressSweep).not.toHaveBeenCalled();
  });

  it("issue-deck側でDISPATCH_SECRETが未設定なら503（設定漏れと値の不一致を分ける）", async () => {
    delete process.env.DISPATCH_SECRET;

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(503);
    expect(runProgressSweep).not.toHaveBeenCalled();
  });

  it("プレビュー環境では403で封じる（worktreeの開発サーバーから本番のIssueを書き換えない）", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(403);
    expect(runProgressSweep).not.toHaveBeenCalled();
  });

  it("巡回が落ちても500を返すだけで、pollerの1巡は止めない", async () => {
    runProgressSweep.mockRejectedValue(new Error("boom"));

    const response = await POST(request({}, "Bearer secret"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "sweep_failed" });
  });
});
