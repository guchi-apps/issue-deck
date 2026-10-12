import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acceptMessageEvent = vi.fn();
const processAcceptedEvent = vi.fn();
vi.mock("@/lib/slack/intake", () => ({
  acceptMessageEvent: (...a: unknown[]) => acceptMessageEvent(...a),
  processAcceptedEvent: (...a: unknown[]) => processAcceptedEvent(...a),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => void) => void fn(),
}));

import { POST } from "@/app/api/slack/events/route";

const SECRET = "route-secret";

function signed(body: string, overrides: { signature?: string; ts?: string } = {}): NextRequest {
  const ts = overrides.ts ?? String(Math.floor(Date.now() / 1000));
  const signature = overrides.signature ?? `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signature, "content-type": "application/json" },
    body,
  }) as unknown as NextRequest;
}

describe("POST /api/slack/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
    acceptMessageEvent.mockResolvedValue({ kind: "queued", requestId: "req-1" });
    processAcceptedEvent.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("連携が未設定なら503", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect((await POST(signed("{}"))).status).toBe(503);
  });

  it("不正な署名は401で、何も処理しない", async () => {
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "E1", event: { type: "message" } });
    const res = await POST(signed(body, { signature: "v0=bad" }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("xoxb-test-token");
    expect(acceptMessageEvent).not.toHaveBeenCalled();
    expect(processAcceptedEvent).not.toHaveBeenCalled();
  });

  it("古いタイムスタンプ（リプレイ）は401", async () => {
    const body = "{}";
    expect((await POST(signed(body, { ts: String(Math.floor(Date.now() / 1000) - 3600) }))).status).toBe(401);
  });

  it("url_verificationにchallengeを返す", async () => {
    const res = await POST(signed(JSON.stringify({ type: "url_verification", challenge: "abc" })));
    expect(await res.json()).toEqual({ challenge: "abc" });
  });

  it("受付（DBへの保存）を済ませてからackし、ack後に処理する。再送（処理済み）は無視する", async () => {
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "E1", event: { type: "message", ts: "1.0" } });
    expect((await POST(signed(body))).status).toBe(200);
    expect(acceptMessageEvent).toHaveBeenCalledWith(expect.anything(), "T1", "E1", { type: "message", ts: "1.0" });
    expect(processAcceptedEvent).toHaveBeenCalledWith(expect.anything(), { kind: "queued", requestId: "req-1" });
    acceptMessageEvent.mockResolvedValue({ kind: "duplicate" });
    const retry = await POST(signed(body));
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    expect(processAcceptedEvent).toHaveBeenCalledTimes(1);
  });

  it("保存に失敗したら500を返してSlackに再送させ、ack後の処理も始めない（#4488）", async () => {
    acceptMessageEvent.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "E9", event: { type: "message", ts: "1.0" } });
    const res = await POST(signed(body));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
    expect(processAcceptedEvent).not.toHaveBeenCalled();
  });

  it("ack後の処理が失敗しても200のまま（依頼はDBに残っており、失敗状態・巡回から続ける）", async () => {
    processAcceptedEvent.mockRejectedValueOnce(new Error("slack down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "E10", event: { type: "message", ts: "1.0" } });
    expect((await POST(signed(body))).status).toBe(200);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
  });
});
