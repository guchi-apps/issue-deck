import { afterEach, describe, expect, it, vi } from "vitest";

import { githubFetch } from "@/lib/github/request";

function connectError(code: string): Error {
  // Node（undici）のfetchは接続失敗をTypeError("fetch failed")で包み、causeに実際の原因を持つ。
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

// 再試行の待ち時間（200ms→600ms）は実時間で待つ。偽タイマーで飛ばすこともできるが、
// 待機と結果待ちの順序を組む必要があり、テストの意図（何回投げ直すか）が読みにくくなるため。
describe("githubFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("接続に失敗したGETは投げ直して成功させる", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await githubFetch("https://api.github.com/rate_limit", "token");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("再試行の上限を超えたら最後のエラーを投げる", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectError("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubFetch("https://api.github.com/rate_limit", "token")).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("POSTやPUTは二重実行を避けるため再試行しない", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectError("UND_ERR_CONNECT_TIMEOUT"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubFetch("https://api.github.com/repos/o/r/pulls/1/merge", "token", { method: "PUT" }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("通信以外の原因で落ちたときは投げ直さない", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Invalid URL"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubFetch("https://api.github.com/rate_limit", "token")).rejects.toThrow(
      "Invalid URL",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTPエラー応答はそのまま返す（再試行の対象にしない）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await githubFetch("https://api.github.com/rate_limit", "token");

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
