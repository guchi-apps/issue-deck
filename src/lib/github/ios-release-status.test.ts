import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConditionalRequestCache } from "@/lib/github/conditional-request";
import { clearIosReleaseStatusMemo, fetchIosReleaseStatus } from "@/lib/github/ios-release-status";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers });

function stubGithub(options: { runs: () => Response; jobs?: () => Response }) {
  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes("/matching-refs/tags/ios-testflight")) return json(200, []);
    if (input.includes("/matching-refs/tags/v")) {
      return json(200, [
        { ref: "refs/tags/v1.0.0", object: { sha: "aaa" } },
        { ref: "refs/tags/v0.9.0", object: { sha: "bbb" } },
      ]);
    }
    if (input.includes("/jobs")) return options.jobs?.() ?? json(200, { jobs: [] });
    return options.runs();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const failedRun = { id: 7, head_sha: "aaa", status: "completed", conclusion: "failure", run_attempt: 1 };

beforeEach(() => {
  clearIosReleaseStatusMemo();
  clearConditionalRequestCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchIosReleaseStatus（#5214）", () => {
  it("304のときは覚えたrunから判定し、失敗段階のジョブを取り直さない", async () => {
    let call = 0;
    const fetchMock = stubGithub({
      runs: () => {
        call += 1;
        return call === 1 ? json(200, { workflow_runs: [failedRun] }, { etag: '"e1"' }) : json(304, null);
      },
    });

    const first = await fetchIosReleaseStatus("o", "r", "t", ["v1.0.0", "v0.9.0"]);
    const second = await fetchIosReleaseStatus("o", "r", "t", ["v1.0.0", "v0.9.0"]);

    expect(Object.keys(first.failed)).toEqual(["v1.0.0"]);
    expect(second).toEqual(first);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url.includes("/jobs"))).toHaveLength(1);
    const runCalls = fetchMock.mock.calls.filter(([url]) => url.includes("/runs?"));
    expect(runCalls).toHaveLength(2);
  });

  it("ワークフローが無いリポジトリ（404）は失敗にせず、実行中なしとして返す", async () => {
    stubGithub({ runs: () => json(404, {}) });
    await expect(fetchIosReleaseStatus("o", "r", "t", ["v1.0.0"])).resolves.toMatchObject({
      failed: {},
      hasActiveRun: false,
    });
  });

  it("run一覧を読めないときは例外にし、全部の版を「自動配布なし」にしない", async () => {
    stubGithub({ runs: () => json(403, {}) });
    await expect(fetchIosReleaseStatus("o", "r", "t", ["v1.0.0"])).rejects.toThrow();
  });

  it("実行中のrunがあれば知らせる", async () => {
    stubGithub({
      runs: () =>
        json(200, { workflow_runs: [{ id: 8, head_sha: "zzz", status: "in_progress", conclusion: null }] }),
    });
    await expect(fetchIosReleaseStatus("o", "r", "t", ["v1.0.0"])).resolves.toMatchObject({ hasActiveRun: true });
  });
});
