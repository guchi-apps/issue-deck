import { beforeEach, describe, expect, it, vi } from "vitest";

const createAlert = vi.fn();
const updateManyAlert = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sharedTokenConsumerAlert: {
      get create() {
        return createAlert;
      },
      get updateMany() {
        return updateManyAlert;
      },
    },
  },
}));

const { notifyUnexpectedSharedTokenConsumer, SHARED_TOKEN_ALERT_INTERVAL_MS } = await import(
  "./shared-token-consumer-alert"
);

const WEBHOOK = "https://discord.com/api/webhooks/123/abc-DEF";
const env = { DISCORD_RELEASE_WEBHOOK_URL: WEBHOOK };
const now = new Date("2026-10-25T03:00:00Z");
const token = { id: "token-1", name: "MYROOM_INTERNAL_BILLS_WRITE_API_KEY", expectedConsumers: ["aide", "myroom"] };
const uniqueError = Object.assign(new Error("unique"), { code: "P2002" });

function okFetch() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

describe("notifyUnexpectedSharedTokenConsumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAlert.mockResolvedValue({});
    updateManyAlert.mockResolvedValue({ count: 1 });
  });

  it("想定内の利用元・想定利用元が未設定のトークンでは何もしない", async () => {
    const fetchImpl = okFetch();
    expect(await notifyUnexpectedSharedTokenConsumer(token, "AIDE", { now, env, fetchImpl })).toBe("expected");
    expect(
      await notifyUnexpectedSharedTokenConsumer({ ...token, expectedConsumers: null }, "hermes-agent", { now, env, fetchImpl }),
    ).toBe("expected");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createAlert).not.toHaveBeenCalled();
  });

  it("投稿先が無ければ記録を取らずに終える", async () => {
    const fetchImpl = okFetch();
    expect(await notifyUnexpectedSharedTokenConsumer(token, "hermes-agent", { now, env: {}, fetchImpl })).toBe(
      "not_configured",
    );
    expect(createAlert).not.toHaveBeenCalled();
  });

  it("想定外の利用元をトークン名・利用元・時刻だけでDiscordへ通知する", async () => {
    const fetchImpl = okFetch();
    expect(await notifyUnexpectedSharedTokenConsumer(token, "Hermes-Agent", { now, env, fetchImpl })).toBe("notified");
    expect(createAlert).toHaveBeenCalledWith({
      data: { sharedTokenId: "token-1", consumer: "hermes-agent", lastNotifiedAt: now },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse(init.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.thread_name).toBe("共有トークン警告 MYROOM_INTERNAL_BILLS_WRITE_API_KEY");
    expect(body.embeds[0].fields.map((field: { name: string }) => field.name)).toEqual(["トークン", "利用元", "時刻"]);
    expect(body.embeds[0].fields[0].value).toBe("MYROOM_INTERNAL_BILLS_WRITE_API_KEY");
    expect(body.embeds[0].fields[1].value).toBe("Hermes-Agent");
    expect(body.embeds[0].timestamp).toBe(now.toISOString());
  });

  it("同じ組は間隔内なら鳴らさず、間隔が空いた記録だけを更新して鳴らす", async () => {
    createAlert.mockRejectedValue(uniqueError);
    updateManyAlert.mockResolvedValueOnce({ count: 0 });
    const fetchImpl = okFetch();
    expect(await notifyUnexpectedSharedTokenConsumer(token, "hermes-agent", { now, env, fetchImpl })).toBe("suppressed");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateManyAlert).toHaveBeenCalledWith({
      where: {
        sharedTokenId: "token-1",
        consumer: "hermes-agent",
        lastNotifiedAt: { lt: new Date(now.getTime() - SHARED_TOKEN_ALERT_INTERVAL_MS) },
      },
      data: { lastNotifiedAt: now },
    });

    expect(await notifyUnexpectedSharedTokenConsumer(token, "hermes-agent", { now, env, fetchImpl })).toBe("notified");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("投稿に失敗したら記録を戻し、次の取得で鳴らし直せるようにする", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await notifyUnexpectedSharedTokenConsumer(token, "hermes-agent", { now, env, fetchImpl })).toBe("failed");
    expect(updateManyAlert).toHaveBeenCalledWith({
      where: { sharedTokenId: "token-1", consumer: "hermes-agent", lastNotifiedAt: now },
      data: { lastNotifiedAt: new Date(0) },
    });
  });
});
