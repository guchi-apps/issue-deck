import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const save = vi.fn();
const report = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { sharedToken: { findUnique: vi.fn().mockResolvedValue(null) }, sharedTokenUsage: { create: vi.fn() } },
}));
vi.mock("@/lib/vps-memory/store", () => ({
  get saveSamples() { return save; },
  get loadReport() { return report; },
}));

import { clearSharedTokenReaderCache } from "@/lib/shared-token-reader";

const { GET } = await import("./route");
const { POST } = await import("./samples/route");

const sample = { sampledAt: new Date().toISOString(), status: "unavailable", reason: "ssh_failed" };
const post = (body: unknown, auth?: string) =>
  POST(new NextRequest("http://localhost/api/integrations/vps-memory/samples", {
    method: "POST", body: JSON.stringify(body), headers: auth ? { authorization: auth } : {},
  }));
const get = (query = "", auth?: string) =>
  GET(new NextRequest(`http://localhost/api/integrations/vps-memory${query}`, { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  clearSharedTokenReaderCache();
  vi.stubEnv("DISPATCH_SECRET", "w");
  vi.stubEnv("VPS_MEMORY_READ_SECRET", "r");
  save.mockReset();
  report.mockReset().mockResolvedValue({ schemaVersion: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /samples", () => {
  it("鍵が無い・違うと401、未設定は503", async () => {
    expect((await post({ samples: [sample] })).status).toBe(401);
    expect((await post({ samples: [sample] }, "Bearer x")).status).toBe(401);
    vi.stubEnv("DISPATCH_SECRET", "");
    expect((await post({ samples: [sample] }, "Bearer w")).status).toBe(503);
  });
  it("取得不可のサンプルも保存する", async () => {
    const res = await post({ samples: [sample] }, "Bearer w");
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
  });
  it("1件でも不正なら何も保存しない", async () => {
    expect((await post({ samples: [sample, { status: "ok" }] }, "Bearer w")).status).toBe(400);
    expect((await post({ samples: [] }, "Bearer w")).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
  it("読み取り鍵では書き込めない", async () => {
    expect((await post({ samples: [sample] }, "Bearer r")).status).toBe(401);
  });
});

describe("GET /", () => {
  it("読み取り鍵で返し、書き込み鍵は通さない", async () => {
    expect((await get("", "Bearer r")).status).toBe(200);
    expect((await get("", "Bearer w")).status).toBe(401);
  });
  it("hoursとhistoryを解釈し、範囲外は400", async () => {
    await get("?hours=48&history=1", "Bearer r");
    expect(report).toHaveBeenCalledWith({ hours: 48, includeSamples: true });
    expect((await get("?hours=0", "Bearer r")).status).toBe(400);
    expect((await get("?hours=999", "Bearer r")).status).toBe(400);
  });
});
