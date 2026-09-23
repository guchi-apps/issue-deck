import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return findUnique;
      },
      get upsert() {
        return upsert;
      },
    },
  },
}));

const { GET, PATCH } = await import("./route");

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/settings/release-prep-interval", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  upsert.mockImplementation(async ({ update }) => ({
    releasePrepIntervalMinutes: update.releasePrepIntervalMinutes,
  }));
});

describe("release-prep-interval settings API", () => {
  it("未設定なら既定の60分を返す", async () => {
    findUnique.mockResolvedValue(null);
    const res = await GET();
    expect(await res.json()).toEqual({ releasePrepIntervalMinutes: 60 });
  });

  it("選択肢の値を保存する（0は自動実行しない）", async () => {
    const res = await PATCH(patchRequest({ releasePrepIntervalMinutes: 0 }));
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { releasePrepIntervalMinutes: 0 } }),
    );
  });

  it.each([10, 45, -15, 1.5, "60", null])("不正な値 %s は400", async (value) => {
    const res = await PATCH(patchRequest({ releasePrepIntervalMinutes: value }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("未ログインは401", async () => {
    requireUserId.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ releasePrepIntervalMinutes: 60 }));
    expect(res.status).toBe(401);
  });
});
