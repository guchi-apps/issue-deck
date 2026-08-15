import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearConditionalRequestCache,
  githubFetchJsonWithEtag,
} from "@/lib/github/conditional-request";

const recordGithubApiCall = vi.hoisted(() => vi.fn());
vi.mock("@/lib/github/api-usage", () => ({ recordGithubApiCall }));

type StubResponse = {
  status: number;
  etag?: string;
  body?: unknown;
};

/** 呼び出しごとに応答を切り替えるfetchスタブ。送ったヘッダも記録する */
function stubFetch(responses: StubResponse[]) {
  const sentHeaders: Record<string, string>[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    sentHeaders.push(init.headers);
    const response = responses[Math.min(sentHeaders.length - 1, responses.length - 1)];
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: { get: (name: string) => (name === "etag" ? (response.etag ?? null) : null) },
      json: async () => response.body,
      text: async () => JSON.stringify(response.body ?? ""),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sentHeaders, fetchMock };
}

beforeEach(() => {
  clearConditionalRequestCache();
  recordGithubApiCall.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubFetchJsonWithEtag（#1531）", () => {
  it("初回は If-None-Match を付けず、2回目は保存したETagを付けて送る", async () => {
    const { sentHeaders } = stubFetch([
      { status: 200, etag: 'W/"abc"', body: [{ number: 1 }] },
      { status: 304 },
    ]);

    await githubFetchJsonWithEtag("https://api.github.com/x", "token");
    await githubFetchJsonWithEtag("https://api.github.com/x", "token");

    expect(sentHeaders[0]["If-None-Match"]).toBeUndefined();
    expect(sentHeaders[1]["If-None-Match"]).toBe('W/"abc"');
  });

  it("304 のときはキャッシュした本文を返す", async () => {
    stubFetch([
      { status: 200, etag: '"abc"', body: [{ number: 1 }] },
      { status: 304 },
    ]);

    await githubFetchJsonWithEtag("https://api.github.com/x", "token");
    const result = await githubFetchJsonWithEtag<{ number: number }[]>(
      "https://api.github.com/x",
      "token",
    );

    expect(result).toEqual({ ok: true, data: [{ number: 1 }], notModified: true });
  });

  it("304 はレート制限を消費しないため使用量に計上しない", async () => {
    stubFetch([
      { status: 200, etag: '"abc"', body: [] },
      { status: 304 },
      { status: 304 },
    ]);

    await githubFetchJsonWithEtag("https://api.github.com/x", "token");
    await githubFetchJsonWithEtag("https://api.github.com/x", "token");
    await githubFetchJsonWithEtag("https://api.github.com/x", "token");

    expect(recordGithubApiCall).toHaveBeenCalledTimes(1);
  });

  it("ETagを返さないエンドポイントはキャッシュせず、毎回そのまま取りに行く", async () => {
    const { sentHeaders } = stubFetch([{ status: 200, body: [] }]);

    await githubFetchJsonWithEtag("https://api.github.com/x", "token");
    await githubFetchJsonWithEtag("https://api.github.com/x", "token");

    expect(sentHeaders[1]["If-None-Match"]).toBeUndefined();
    expect(recordGithubApiCall).toHaveBeenCalledTimes(2);
  });

  it("失敗は例外にせずstatusを返す（呼び出し側で投げるか縮退させるかを決める）", async () => {
    stubFetch([{ status: 404, body: { message: "Not Found" } }]);

    const result = await githubFetchJsonWithEtag("https://api.github.com/x", "token");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404 });
    expect(recordGithubApiCall).toHaveBeenCalledTimes(1);
  });

  it("URLごとに別のETagを保持する", async () => {
    const { sentHeaders } = stubFetch([
      { status: 200, etag: '"a"', body: 1 },
      { status: 200, etag: '"b"', body: 2 },
      { status: 304 },
      { status: 304 },
    ]);

    await githubFetchJsonWithEtag("https://api.github.com/a", "token");
    await githubFetchJsonWithEtag("https://api.github.com/b", "token");
    await githubFetchJsonWithEtag("https://api.github.com/a", "token");
    await githubFetchJsonWithEtag("https://api.github.com/b", "token");

    expect(sentHeaders[2]["If-None-Match"]).toBe('"a"');
    expect(sentHeaders[3]["If-None-Match"]).toBe('"b"');
  });

  it("上限を超えたら参照が古いものから捨てる（check-runsのURLはSHAごとに増えるため）", async () => {
    // 上限は500件。501件入れると最初の1件が落ち、直後に参照した1件は残る。
    stubFetch([{ status: 200, etag: '"e"', body: null }]);

    for (let i = 0; i < 501; i += 1) {
      await githubFetchJsonWithEtag(`https://api.github.com/n${i}`, "token");
    }

    const { sentHeaders } = stubFetch([{ status: 304 }, { status: 304 }]);
    await githubFetchJsonWithEtag("https://api.github.com/n0", "token");
    await githubFetchJsonWithEtag("https://api.github.com/n500", "token");

    expect(sentHeaders[0]["If-None-Match"]).toBeUndefined();
    expect(sentHeaders[1]["If-None-Match"]).toBe('"e"');
  });
});
