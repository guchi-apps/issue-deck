import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPullRequest } from "@/lib/github/actions-api";
import { clearConditionalRequestCache } from "@/lib/github/conditional-request";

afterEach(() => {
  vi.unstubAllGlobals();
  clearConditionalRequestCache();
});

describe("fetchPullRequest のETag（#5382）", () => {
  it("2回目はIf-None-Matchを送り、304ならキャッシュの写しを返す", async () => {
    const body = { number: 1, body: "本文", state: "open", head: { sha: "h", ref: "issue-1" }, base: { ref: "develop" } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: '"v1"' }), json: async () => body })
      .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers(), json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchPullRequest("guchi-apps", "issue-deck", 1, "token");
    first.body = "書き換え";
    const second = await fetchPullRequest("guchi-apps", "issue-deck", 1, "token");

    const secondInit = fetchMock.mock.calls[1][1] as { headers: Headers | Record<string, string> };
    const headers = new Headers(secondInit.headers as HeadersInit);
    expect(headers.get("If-None-Match")).toBe('"v1"');
    // 呼び出し側の書き換えはキャッシュへ残らない
    expect(second.body).toBe("本文");
  });
});
