import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FetchTimeoutError, fetchWithTimeout, isAbortError } from "./fetch-with-timeout";

/** 渡されたsignalが中断されるまで決着しないfetch（応答が返らない回線を再現する） */
function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    // 本物のfetchと同じく、中断済みのsignalならすぐに失敗させる
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("期限までに返った応答はそのまま返す", async () => {
    const response = new Response("ok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchWithTimeout("/api/x")).resolves.toBe(response);
  });

  it("応答が返らないまま期限を過ぎるとFetchTimeoutErrorで失敗する", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const promise = fetchWithTimeout("/api/x", { timeoutMs: 1_000 });
    const assertion = expect(promise).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("タイムアウトは呼び出し側の中断（AbortError）と区別できる", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const promise = fetchWithTimeout("/api/x", { timeoutMs: 1_000 });
    const caught = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isAbortError(await caught)).toBe(false);
  });

  it("呼び出し側のsignalで中断すると、その理由（AbortError）で失敗する", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const controller = new AbortController();
    const promise = fetchWithTimeout("/api/x", { signal: controller.signal });
    const caught = promise.catch((err: unknown) => err);
    controller.abort();
    expect(isAbortError(await caught)).toBe(true);
  });

  it("中断済みのsignalを渡すと、すぐに中断される", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const controller = new AbortController();
    controller.abort();
    const caught = await fetchWithTimeout("/api/x", { signal: controller.signal }).catch(
      (err: unknown) => err,
    );
    expect(isAbortError(caught)).toBe(true);
  });

  it("timeoutMsはfetchへ渡さない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithTimeout("/api/x", { timeoutMs: 5, cache: "no-store" });
    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init).not.toHaveProperty("timeoutMs");
    expect(init.cache).toBe("no-store");
  });
});
