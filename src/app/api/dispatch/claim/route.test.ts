import { beforeEach, describe, expect, it, vi } from "vitest";

const claimDispatchJobs = vi.fn();
const sweepCheckUserPushNotifications = vi.fn();
const appSettingFindUnique = vi.fn();

vi.mock("@/lib/dispatch/jobs", () => ({
  get claimDispatchJobs() {
    return claimDispatchJobs;
  },
}));

vi.mock("@/lib/notifications/check-user-push", () => ({
  get sweepCheckUserPushNotifications() {
    return sweepCheckUserPushNotifications;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return appSettingFindUnique;
      },
    },
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization = "Bearer secret-value") {
  return new Request("http://localhost/api/dispatch/claim", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  claimDispatchJobs.mockResolvedValue([]);
  sweepCheckUserPushNotifications.mockResolvedValue(undefined);
  appSettingFindUnique.mockResolvedValue({ claudeLocalModel: "sonnet", codexModel: "auto" });
});

describe("POST /api/dispatch/claim", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest({ host: "subpc" }));
    expect(res.status).toBe(503);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest({ host: "subpc" }, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  it("ホスト名が無ければ400", async () => {
    const res = await POST(postRequest({ maxJobs: 1 }));
    expect(res.status).toBe(400);
    expect(claimDispatchJobs).not.toHaveBeenCalled();
  });

  // 通常の巡回（30秒に1回）。相乗りしている確認待ちPush通知の巡回（#838）はここで回る
  it("通常の巡回では確認待ちPush通知の巡回も1歩進める", async () => {
    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));
    expect(res.status).toBe(200);
    expect(sweepCheckUserPushNotifications).toHaveBeenCalledTimes(1);
    expect(claimDispatchJobs).toHaveBeenCalledWith({ hostName: "subpc", maxJobs: 1 });
  });

  // 軽い巡回（#2413）は数秒間隔で来る。30秒に1回来る前提で相乗りさせた処理を、
  // そのまま10倍回さない
  it("fast: true では相乗りの巡回を省き、払い出しはそのまま行う", async () => {
    const res = await POST(postRequest({ host: "subpc", maxJobs: 0, fast: true }));
    expect(res.status).toBe(200);
    expect(sweepCheckUserPushNotifications).not.toHaveBeenCalled();
    expect(claimDispatchJobs).toHaveBeenCalledWith({ hostName: "subpc", maxJobs: 0 });
    expect(appSettingFindUnique).not.toHaveBeenCalled();
  });

  // 相乗りの巡回が落ちても払い出しは続ける（#838のときからの約束）
  it("相乗りの巡回が失敗してもジョブは払い出す", async () => {
    sweepCheckUserPushNotifications.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    claimDispatchJobs.mockResolvedValue([{ id: "job-1" }]);

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      jobs: [{ id: "job-1", claudeLocalModel: "sonnet", codexModel: "auto" }],
    });
    consoleError.mockRestore();
  });

  it("保存済みのCodexモデルを払い出すジョブへ付ける", async () => {
    claimDispatchJobs.mockResolvedValue([{ id: "job-1" }]);
    appSettingFindUnique.mockResolvedValue({
      claudeLocalModel: "opus",
      codexModel: "gpt-5.6-terra",
    });

    const res = await POST(postRequest({ host: "subpc", maxJobs: 1 }));

    expect(await res.json()).toEqual({
      ok: true,
      jobs: [{ id: "job-1", claudeLocalModel: "opus", codexModel: "gpt-5.6-terra" }],
    });
  });
});
