import { afterEach, describe, expect, it, vi } from "vitest";

import { clearConditionalRequestCache } from "@/lib/github/conditional-request";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  fetchPullRequestFiles,
  type GithubApiPullRequestFile,
} from "@/lib/github/pull-requests-api";

function makeFile(overrides: Partial<GithubApiPullRequestFile> = {}): GithubApiPullRequestFile {
  return {
    filename: "src/lib/github/pull-requests-api.ts",
    status: "modified",
    additions: 41,
    deletions: 0,
    blob_url: "https://github.com/guchi-apps/issue-deck/blob/abc/src/lib/github/pull-requests-api.ts",
    ...overrides,
  };
}

/** GitHub REST の応答を返すfetchスタブ。要求したURLとヘッダーを記録する */
function stubRest(responses: { status: number; body?: unknown; etag?: string }[]) {
  const requests: { url: string; ifNoneMatch: string | null }[] = [];
  let index = 0;
  const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    requests.push({ url, ifNoneMatch: init?.headers?.["If-None-Match"] ?? null });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: new Headers(response.etag ? { etag: response.etag } : {}),
      json: async () => response.body,
      text: async () => JSON.stringify(response.body ?? ""),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearConditionalRequestCache();
});

describe("fetchPullRequestFiles", () => {
  it("1ページ（100件）だけ取得する", async () => {
    const { requests } = stubRest([{ status: 200, body: [makeFile()] }]);

    const files = await fetchPullRequestFiles("guchi-apps", "issue-deck", 42, "token");

    expect(files).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://api.github.com/repos/guchi-apps/issue-deck/pulls/42/files?per_page=100",
    );
  });

  it("2回目はETagの条件付きGETになり、304ならキャッシュを返す", async () => {
    const { requests } = stubRest([
      { status: 200, body: [makeFile()], etag: 'W/"abc"' },
      { status: 304 },
    ]);

    await fetchPullRequestFiles("guchi-apps", "issue-deck", 42, "token");
    const cached = await fetchPullRequestFiles("guchi-apps", "issue-deck", 42, "token");

    expect(requests[1].ifNoneMatch).toBe('W/"abc"');
    expect(cached.map((file) => file.filename)).toEqual(["src/lib/github/pull-requests-api.ts"]);
  });

  it("失敗はGithubApiErrorとして投げる", async () => {
    stubRest([{ status: 404, body: { message: "Not Found" } }]);

    await expect(
      fetchPullRequestFiles("guchi-apps", "issue-deck", 42, "token"),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
