import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    githubInstallation: { findMany },
    sharedToken: { findUnique: vi.fn().mockResolvedValue(null) },
    sharedTokenUsage: { create: vi.fn() },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("tok"),
}));
const resources = [{ key: "core", label: "REST", limit: 5000, remaining: 4000, used: 1000, reset: 1 }];
vi.mock("@/lib/github/rate-limit", () => ({
  fetchRateLimit: vi.fn().mockResolvedValue(resources),
}));

const { GET } = await import("./route");

function request(authorization?: string) {
  return new Request("http://localhost/api/github/rate-limit/apps", {
    headers: authorization ? { authorization } : {},
  }) as unknown as Parameters<typeof GET>[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/github/rate-limit/apps", () => {
  it("設定が無ければ503を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "");
    expect((await GET(request("Bearer x"))).status).toBe(503);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("トークンが違えば401を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "secret");
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("全インストールの枠を返す", async () => {
    vi.stubEnv("OPS_API_TOKEN", "secret");
    findMany.mockResolvedValue([{ installationId: 1, accountLogin: "guchi-apps" }]);
    const response = await GET(request("Bearer secret"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installations: [{ accountLogin: "guchi-apps", resources }],
    });
  });
});
