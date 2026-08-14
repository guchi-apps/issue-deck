import { beforeEach, describe, expect, it, vi } from "vitest";

const reportDispatchSessions = vi.fn();

vi.mock("@/lib/dispatch/sessions", () => ({
  get reportDispatchSessions() {
    return reportDispatchSessions;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const validSession = {
  tmuxSessionName: "issue-deck-issue-1217",
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 1217,
  paneDead: false,
  paneDeadStatus: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  reportDispatchSessions.mockResolvedValue({ sessions: [], escalated: 0 });
});

describe("POST /api/dispatch/sessions", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest({ host: "subpc", sessions: [] }, "Bearer secret-value"));
    expect(res.status).toBe(503);
    expect(reportDispatchSessions).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest({ host: "subpc", sessions: [] }, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(reportDispatchSessions).not.toHaveBeenCalled();
  });

  it("ホスト名が無ければ400", async () => {
    const res = await POST(postRequest({ sessions: [] }, "Bearer secret-value"));
    expect(res.status).toBe(400);
  });

  it("sessionsが配列でなければ400", async () => {
    const res = await POST(postRequest({ host: "subpc" }, "Bearer secret-value"));
    expect(res.status).toBe(400);
  });

  it("空配列を受け付ける（0本の報告で消失を判定するため）", async () => {
    const res = await POST(postRequest({ host: "subpc", sessions: [] }, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(reportDispatchSessions).toHaveBeenCalledWith({ hostName: "subpc", sessions: [] });
  });

  it("妥当な報告を渡す", async () => {
    const res = await POST(
      postRequest({ host: "subpc", sessions: [validSession] }, "Bearer secret-value"),
    );
    expect(res.status).toBe(200);
    expect(reportDispatchSessions).toHaveBeenCalledWith({
      hostName: "subpc",
      sessions: [validSession],
    });
  });

  it("1件でも壊れていれば全体を拒否する（一部だけ受けると生きているセッションがGONEになる）", async () => {
    const res = await POST(
      postRequest(
        { host: "subpc", sessions: [validSession, { ...validSession, issueNumber: 0 }] },
        "Bearer secret-value",
      ),
    );
    expect(res.status).toBe(400);
    expect(reportDispatchSessions).not.toHaveBeenCalled();
  });

  it("本文がJSONでなくても落ちずに400を返す", async () => {
    const request = new Request("http://localhost/api/dispatch/sessions", {
      method: "POST",
      headers: { authorization: "Bearer secret-value" },
      body: "not json",
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(request);
    expect(res.status).toBe(400);
  });
});
