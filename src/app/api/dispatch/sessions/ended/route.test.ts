import { beforeEach, describe, expect, it, vi } from "vitest";

const markDispatchSessionEnded = vi.fn();

vi.mock("@/lib/dispatch/sessions", () => ({
  get markDispatchSessionEnded() {
    return markDispatchSessionEnded;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions/ended", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const validBody = { host: "subpc", tmuxSessionName: "issue-deck-issue-1321" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  markDispatchSessionEnded.mockResolvedValue({ updated: 1 });
});

describe("POST /api/dispatch/sessions/ended", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(503);
    expect(markDispatchSessionEnded).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest(validBody, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(markDispatchSessionEnded).not.toHaveBeenCalled();
  });

  it("ホスト名が無ければ400", async () => {
    const res = await POST(
      postRequest({ tmuxSessionName: "issue-deck-issue-1321" }, "Bearer secret-value"),
    );
    expect(res.status).toBe(400);
    expect(markDispatchSessionEnded).not.toHaveBeenCalled();
  });

  it("セッション名が無ければ400", async () => {
    const res = await POST(postRequest({ host: "subpc" }, "Bearer secret-value"));
    expect(res.status).toBe(400);
    expect(markDispatchSessionEnded).not.toHaveBeenCalled();
  });

  it("受け付けた1件をそのまま渡す", async () => {
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1 });
    expect(markDispatchSessionEnded).toHaveBeenCalledWith({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1321",
    });
  });

  // 呼び出し側（run-issue-session.shのcleanup）はセッションの終了処理の最中で、
  // 再送の判断をさせる相手ではない。取りこぼしても次の巡回でpollerが拾う
  it("対象の行が無くても200で返す", async () => {
    markDispatchSessionEnded.mockResolvedValue({ updated: 0 });
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 0 });
  });
});
