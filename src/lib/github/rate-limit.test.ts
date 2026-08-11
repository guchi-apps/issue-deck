import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRateLimit } from "@/lib/github/rate-limit";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRateLimit", () => {
  it("RESTとGraphQLの両方を枠として返す", async () => {
    // Projects v2はGraphQL専用APIのため、coreだけ見ていると進捗管理の消費が画面に出ない
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          resources: {
            core: { limit: 5000, remaining: 4945, used: 55, reset: 100 },
            graphql: { limit: 5000, remaining: 4800, used: 200, reset: 200 },
            search: { limit: 30, remaining: 30, used: 0, reset: 300 },
          },
        }),
      ),
    );

    const resources = await fetchRateLimit("token");

    expect(resources.map((r) => r.key)).toEqual(["core", "graphql"]);
    expect(resources[0]).toMatchObject({ label: "REST", limit: 5000, used: 55 });
    expect(resources[1]).toMatchObject({ label: "GraphQL", limit: 5000, used: 200 });
  });

  it("応答に含まれない枠は除外する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          resources: { core: { limit: 5000, remaining: 5000, used: 0, reset: 1 } },
        }),
      ),
    );

    const resources = await fetchRateLimit("token");

    expect(resources.map((r) => r.key)).toEqual(["core"]);
  });

  it("使用量として計上しない（レート制限を消費しないエンドポイントのため）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        resources: { core: { limit: 5000, remaining: 5000, used: 0, reset: 1 } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRateLimit("token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/rate_limit");
  });

  it("HTTPエラーは例外にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));

    await expect(fetchRateLimit("token")).rejects.toThrow("GitHub API request failed: 500");
  });
});
