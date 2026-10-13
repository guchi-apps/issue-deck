import { afterEach, describe, expect, it, vi } from "vitest";

import { requestReleaseBulk, requestReleaseStart } from "@/lib/release-request";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}


afterEach(() => vi.unstubAllGlobals());

describe("requestReleaseStart", () => {
  it("新方式対応repoでは候補を作り、旧方式APIを呼ばない", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/start-mode")) return { body: { modes: { "o/a": { mode: "candidate" } } } };
      return { body: { ok: true, candidateId: "c1", revision: 0, existing: false } };
    });
    const result = await requestReleaseStart("o/a", { allowLegacy: true, requestKey: "rc-key-12345" });
    expect(result).toEqual({ kind: "candidate", candidateId: "c1", existing: false });
    const post = calls.find((c) => c.url === "/api/repositories/release/rc");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ action: "create", requestKey: "rc-key-12345" });
    expect(calls.some((c) => c.url === "/api/repositories/release")).toBe(false);
  });

  it("未対応repoは、個別操作（allowLegacy）のときだけ旧方式で起動する", async () => {
    const calls = mockFetch((url) =>
      url.includes("/start-mode") ? { body: { modes: { "o/a": { mode: "legacy", label: "未対応" } } } } : { body: {} },
    );
    await expect(requestReleaseStart("o/a", { allowLegacy: false })).rejects.toThrow("未対応");
    expect(calls.some((c) => c.url === "/api/repositories/release")).toBe(false);
    await expect(requestReleaseStart("o/a", { allowLegacy: true })).resolves.toEqual({ kind: "legacy" });
  });

  it("取得に失敗したら判定不能として起動しない", async () => {
    const calls = mockFetch((url) => (url.includes("/start-mode") ? { status: 500, body: {} } : { body: {} }));
    await expect(requestReleaseStart("o/a", { allowLegacy: true })).rejects.toThrow();
    expect(calls.every((c) => c.url.includes("/start-mode"))).toBe(true);
  });

  it("候補作成の失敗（進行中の候補・旧方式の候補）を文言で返す", async () => {
    mockFetch((url) =>
      url.includes("/start-mode")
        ? { body: { modes: { "o/a": { mode: "candidate" } } } }
        : { status: 409, body: { ok: false, error: "rc_active" } },
    );
    await expect(requestReleaseStart("o/a", { allowLegacy: true })).rejects.toThrow("進行中のリリース候補");
  });
});

describe("requestReleaseBulk", () => {
  it("未対応repoへ旧方式を起動せず、対応repoだけ候補を作る", async () => {
    const calls = mockFetch((url, init) => {
      if (url.includes("/start-mode")) {
        const repo = decodeURIComponent(url.split("repos=")[1]);
        return { body: { modes: { [repo]: repo === "o/a" ? { mode: "candidate" } : { mode: "legacy", label: "未対応" } } } };
      }
      void init;
      return { body: { ok: true, candidateId: "c1", revision: 0, existing: false } };
    });
    const result = await requestReleaseBulk(["o/a", "o/b"]);
    expect(result.succeeded).toEqual(["o/a"]);
    expect(result.failed.map((f) => f.repoFullName)).toEqual(["o/b"]);
    expect(calls.some((c) => c.url === "/api/repositories/release")).toBe(false);
  });
});
