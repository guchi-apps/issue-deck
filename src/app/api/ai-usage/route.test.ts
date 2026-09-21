import { afterEach, describe, expect, it, vi } from "vitest";

const getAiUsageSummary = vi.fn();

vi.mock("@/lib/ai-usage-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-usage-export")>()),
  getAiUsageSummary,
}));

const { GET } = await import("./route");

function request(authorization?: string) {
  return new Request("http://localhost/api/ai-usage", {
    headers: authorization ? { authorization } : {},
  }) as unknown as Parameters<typeof GET>[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/ai-usage", () => {
  it("設定が無ければ503を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "");

    const response = GET(request("Bearer token"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "not_configured" });
    expect(getAiUsageSummary).not.toHaveBeenCalled();
  });

  it("トークンが無いか一致しなければ401を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "expected-token");

    const noToken = GET(request());
    expect(noToken.status).toBe(401);
    await expect(noToken.json()).resolves.toEqual({ error: "unauthorized" });
    expect(GET(request("Bearer incorrect")).status).toBe(401);
    expect(getAiUsageSummary).not.toHaveBeenCalled();
  });

  it("認証済みのops-dashboardへモデル別の集計をキャッシュせず返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "expected-token");
    const usage = { features: [] };
    getAiUsageSummary.mockReturnValue(usage);

    const response = GET(request("Bearer expected-token"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(usage);
  });
});
