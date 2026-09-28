import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const isSupabaseManagementApiConfigured = vi.fn();
const listRedirectUrls = vi.fn();
const addRedirectUrl = vi.fn();
const replaceRedirectUrl = vi.fn();
const removeRedirectUrl = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/supabase/config", () => ({
  get isSupabaseManagementApiConfigured() {
    return isSupabaseManagementApiConfigured;
  },
}));

vi.mock("@/lib/supabase/management-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase/management-api")>(
    "@/lib/supabase/management-api",
  );
  return {
    ...actual,
    get listRedirectUrls() {
      return listRedirectUrls;
    },
    get addRedirectUrl() {
      return addRedirectUrl;
    },
    get replaceRedirectUrl() {
      return replaceRedirectUrl;
    },
    get removeRedirectUrl() {
      return removeRedirectUrl;
    },
  };
});

const { GET, POST, PATCH, DELETE } = await import("./route");
const { SupabaseManagementApiError } = await import("@/lib/supabase/management-api");

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/settings/supabase-redirect-urls", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PREVIEW_MODE;
  requireUserId.mockResolvedValue("user-1");
  isSupabaseManagementApiConfigured.mockReturnValue(true);
});

describe("GET", () => {
  it("一覧を返す", async () => {
    listRedirectUrls.mockResolvedValue(["https://a.example.com/cb"]);
    const res = await GET();
    expect(await res.json()).toEqual({ redirectUrls: ["https://a.example.com/cb"] });
  });

  it("未ログインは401", async () => {
    requireUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("未設定は501", async () => {
    isSupabaseManagementApiConfigured.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(501);
  });
});

describe("POST", () => {
  it("追加して一覧を返す", async () => {
    addRedirectUrl.mockResolvedValue(["https://a.example.com/cb"]);
    const res = await POST(request("POST", { url: "https://a.example.com/cb" }));
    expect(res.status).toBe(200);
    expect(addRedirectUrl).toHaveBeenCalledWith("https://a.example.com/cb");
  });

  it("不正なURLは400", async () => {
    const res = await POST(request("POST", { url: "not-a-url" }));
    expect(res.status).toBe(400);
    expect(addRedirectUrl).not.toHaveBeenCalled();
  });

  it("重複はライブラリのエラーのステータスを引き継ぐ", async () => {
    addRedirectUrl.mockRejectedValue(new SupabaseManagementApiError(409, "既に登録されています"));
    const res = await POST(request("POST", { url: "https://a.example.com/cb" }));
    expect(res.status).toBe(409);
  });

  it("PREVIEW_MODEでは403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";
    const res = await POST(request("POST", { url: "https://a.example.com/cb" }));
    expect(res.status).toBe(403);
    expect(addRedirectUrl).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("置換して一覧を返す", async () => {
    replaceRedirectUrl.mockResolvedValue(["https://a2.example.com/cb"]);
    const res = await PATCH(
      request("PATCH", { oldUrl: "https://a.example.com/cb", newUrl: "https://a2.example.com/cb" }),
    );
    expect(res.status).toBe(200);
    expect(replaceRedirectUrl).toHaveBeenCalledWith(
      "https://a.example.com/cb",
      "https://a2.example.com/cb",
    );
  });

  it("対象が見つからなければ404", async () => {
    replaceRedirectUrl.mockRejectedValue(new SupabaseManagementApiError(404, "対象のURLが見つかりません"));
    const res = await PATCH(
      request("PATCH", { oldUrl: "https://missing.example.com/cb", newUrl: "https://new.example.com/cb" }),
    );
    expect(res.status).toBe(404);
  });

  it("PREVIEW_MODEでは403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";
    const res = await PATCH(
      request("PATCH", { oldUrl: "https://a.example.com/cb", newUrl: "https://a2.example.com/cb" }),
    );
    expect(res.status).toBe(403);
    expect(replaceRedirectUrl).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("削除して一覧を返す", async () => {
    removeRedirectUrl.mockResolvedValue([]);
    const res = await DELETE(request("DELETE", { url: "https://a.example.com/cb" }));
    expect(res.status).toBe(200);
    expect(removeRedirectUrl).toHaveBeenCalledWith("https://a.example.com/cb");
  });

  it("PREVIEW_MODEでは403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";
    const res = await DELETE(request("DELETE", { url: "https://a.example.com/cb" }));
    expect(res.status).toBe(403);
    expect(removeRedirectUrl).not.toHaveBeenCalled();
  });
});
