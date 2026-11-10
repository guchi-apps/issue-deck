import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientErrorMessage,
  fetchWithRetry,
  isNetworkFailure,
  NETWORK_FAILURE_MESSAGE,
} from "./client-error-message";

describe("clientErrorMessage", () => {
  it.each(["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."])(
    "%s を日本語にする",
    (message) => {
      expect(clientErrorMessage(new TypeError(message))).toBe(NETWORK_FAILURE_MESSAGE);
    },
  );

  it("通信失敗以外はそのまま返す", () => {
    expect(clientErrorMessage(new Error("Load failed"))).toBe("Load failed");
    expect(clientErrorMessage(new Error("権限がありません"))).toBe("権限がありません");
    expect(clientErrorMessage("x")).toBe("x");
    expect(isNetworkFailure(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("通信失敗なら1回だけ再取得する", async () => {
    const ok = new Response("ok");
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("/x", undefined, 0)).resolves.toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("2回続けて失敗したら例外を返す", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("/x", undefined, 0)).rejects.toThrow("Load failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("通信失敗以外は再取得しない", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("/x", undefined, 0)).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
