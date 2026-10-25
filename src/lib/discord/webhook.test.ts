import { describe, expect, it, vi } from "vitest";
import { clipThreadName, DiscordWebhookError, postWebhookMessage } from "./webhook";

const URL = "https://discord.com/api/webhooks/1/abc";
const res = (status: number) => new Response(null, { status });

describe("postWebhookMessage", () => {
  it("threadNameをthread_nameとして送る", async () => {
    const fetchImpl = vi.fn(async () => res(204));
    await postWebhookMessage(URL, { embeds: [], threadName: "a/b v1" }, fetchImpl as unknown as typeof fetch);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.thread_name).toBe("a/b v1");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("400ならthread_nameを外して1回だけ送り直す", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(400)).mockResolvedValueOnce(res(204));
    await postWebhookMessage(URL, { content: "x", threadName: "t" }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string).thread_name).toBeUndefined();
  });

  it("送り直しも失敗したらエラーにする", async () => {
    const fetchImpl = vi.fn(async () => res(400));
    await expect(
      postWebhookMessage(URL, { content: "x", threadName: "t" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(DiscordWebhookError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("thread_nameを使わない投稿は400でも送り直さない", async () => {
    const fetchImpl = vi.fn(async () => res(400));
    await expect(postWebhookMessage(URL, { content: "x" }, fetchImpl as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("clipThreadName", () => {
  it("100文字に収める", () => {
    expect(Array.from(clipThreadName("あ".repeat(150))).length).toBe(100);
    expect(clipThreadName("a/b v1")).toBe("a/b v1");
  });
});
