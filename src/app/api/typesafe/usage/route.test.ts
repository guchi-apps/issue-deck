import { afterEach, describe, expect, it, vi } from "vitest";

const getTypeSafeUsageSummary = vi.fn();

vi.mock("@/lib/typesafe/usage", () => ({
  getTypeSafeUsageSummary,
}));

const { GET } = await import("./route");

function request(authorization?: string) {
  return new Request("http://localhost/api/typesafe/usage", {
    headers: authorization ? { authorization } : {},
  }) as unknown as Parameters<typeof GET>[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/typesafe/usage", () => {
  it("設定が無ければ503を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "");

    const response = GET(request("Bearer token"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "not_configured" });
    expect(getTypeSafeUsageSummary).not.toHaveBeenCalled();
  });

  it("トークンが無いか一致しなければ401を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "expected-token");

    await expect(GET(request()).json()).resolves.toEqual({ error: "unauthorized" });
    await expect(GET(request("Bearer incorrect")).json()).resolves.toEqual({ error: "unauthorized" });
    expect(getTypeSafeUsageSummary).not.toHaveBeenCalled();
  });

  it("認証済みのops-dashboardへJev限定の集計をキャッシュせず返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "expected-token");
    const usage = {
      last24h: { calls: 2, inputTokens: 200 },
      last7d: { calls: 4, inputTokens: 400 },
      features: [],
    };
    getTypeSafeUsageSummary.mockReturnValue(usage);

    const response = GET(request("Bearer expected-token"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(usage);
    expect(getTypeSafeUsageSummary).toHaveBeenCalledOnce();
  });
});
