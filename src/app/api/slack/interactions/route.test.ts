import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), accept: vi.fn(), after: vi.fn(), process: vi.fn(), claim: vi.fn(), handle: vi.fn() }));
vi.mock("next/server", async () => ({ ...(await vi.importActual("next/server")), after: mocks.after }));
vi.mock("@/lib/slack/route-helpers", () => ({ authenticateSlackRequest: mocks.auth }));
vi.mock("@/lib/slack/intake", () => ({ acceptIssueConfirmation: mocks.accept, processPendingRequest: mocks.process, claimEvent: mocks.claim, handleInteraction: mocks.handle }));
import { POST } from "./route";
const ctx = { config: {}, client: {} };
const payload = { type: "block_actions", trigger_id: "trigger-1", actions: [{ action_id: "slack_issue_confirm", value: "req-1" }] };
const request = new Request("https://example.com/api/slack/interactions", { method: "POST" }) as NextRequest;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, ctx, rawBody: new URLSearchParams({ payload: JSON.stringify(payload) }).toString() });
  mocks.accept.mockResolvedValue("req-1");
});
describe("Slack起案確定のack", () => {
  it("ack前に確定操作を保存し、ack後のジョブへ依頼IDだけを渡す", async () => {
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith(ctx.config, payload);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.process).toHaveBeenCalledWith(ctx, "req-1");
  });
  it("DB保存失敗は503として再送させ、処理済みイベントとして消費しない", async () => {
    mocks.accept.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(request)).status).toBe(503);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("既に保存済み・権限外の確定操作はackして追加処理を始めない", async () => {
    mocks.accept.mockResolvedValueOnce(null);
    expect((await POST(request)).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("ack後の処理が中断しても保存済みの依頼を削除しない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.process.mockRejectedValueOnce(new Error("interrupted"));
    expect((await POST(request)).status).toBe(200);
    await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(mocks.accept).toHaveBeenCalledTimes(1);
  });
});
