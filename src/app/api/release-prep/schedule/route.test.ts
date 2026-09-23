import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeProgressReport = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/progress-report-auth", () => ({
  get authorizeProgressReport() {
    return authorizeProgressReport;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return findUnique;
      },
    },
  },
}));

const { GET } = await import("./route");

function request() {
  return new Request("http://localhost/api/release-prep/schedule", {
    headers: { authorization: "Bearer x" },
  }) as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeProgressReport.mockReturnValue("ok");
});

describe("GET /api/release-prep/schedule", () => {
  it("設定値を返す", async () => {
    findUnique.mockResolvedValue({ releasePrepIntervalMinutes: 360 });
    const res = await GET(request());
    expect(await res.json()).toEqual({ intervalMinutes: 360 });
  });

  it("未設定なら既定の60分", async () => {
    findUnique.mockResolvedValue(null);
    const res = await GET(request());
    expect(await res.json()).toEqual({ intervalMinutes: 60 });
  });

  it("認証に失敗したら401、未設定は503", async () => {
    authorizeProgressReport.mockReturnValue("unauthorized");
    expect((await GET(request())).status).toBe(401);
    authorizeProgressReport.mockReturnValue("not_configured");
    expect((await GET(request())).status).toBe(503);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
