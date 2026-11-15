import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getGithubApiUsageSummary, resetGithubApiUsage } from "@/lib/github/api-usage";
import {
  clearIosTestflightFetchMemo,
  fetchCompletedJobAnnotations,
  fetchIosRunJobs,
  fetchRecentIosRuns,
} from "@/lib/github/ios-testflight-fetch";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers });

const run = {
  id: 7,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/7",
  head_sha: "aaa",
  head_branch: "main",
  event: "workflow_dispatch",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:10:00Z",
  run_attempt: 1,
  // 使わない項目は覚えない
  repository: { full_name: "o/r", huge: "x".repeat(1000) },
};

const job = { id: 70, name: "detect", status: "completed", conclusion: "success", steps: [] };

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 計上されたRESTの呼び出し数（304は計上されない） */
const counted = () => getGithubApiUsageSummary().totalLast24h;

beforeEach(() => {
  clearIosTestflightFetchMemo();
  resetGithubApiUsage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRecentIosRuns（#5438）", () => {
  it("2回目は条件付きGETにし、304なら覚えたrunを返して枠を消費しない", async () => {
    let call = 0;
    const fetchMock = stub(() => {
      call += 1;
      return call === 1 ? json(200, { workflow_runs: [run] }, { etag: '"e1"' }) : json(304, null);
    });

    const first = await fetchRecentIosRuns("o", "r", "t", 3);
    const second = await fetchRecentIosRuns("o", "r", "t", 3);

    expect(second).toEqual(first);
    expect(first?.[0]).not.toHaveProperty("repository");
    expect(first?.[0]).toMatchObject({ id: 7, head_sha: "aaa", run_attempt: 1 });
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(secondHeaders["If-None-Match"]).toBe('"e1"');
    expect(counted()).toBe(1);
  });

  it("ワークフローが無い（404）ときはnull", async () => {
    stub(() => json(404, { message: "Not Found" }));
    expect(await fetchRecentIosRuns("o", "r", "t", 3)).toBeNull();
  });
});

describe("fetchIosRunJobs（#5438）", () => {
  it("完了したrunのjobsは覚えて取り直さない", async () => {
    const fetchMock = stub(() => json(200, { jobs: [job] }));

    await fetchIosRunJobs("o", "r", run, "t");
    const second = await fetchIosRunJobs("o", "r", run, "t");

    expect(second).toEqual([{ ...job, started_at: undefined, completed_at: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("実行中のrunは毎回取り直す", async () => {
    const fetchMock = stub(() => json(200, { jobs: [{ ...job, status: "in_progress", conclusion: null }] }));
    const running = { ...run, status: "in_progress" };

    await fetchIosRunJobs("o", "r", running, "t");
    await fetchIosRunJobs("o", "r", running, "t");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("再実行（run_attemptが増えた）なら取り直す", async () => {
    const fetchMock = stub(() => json(200, { jobs: [job] }));

    await fetchIosRunJobs("o", "r", run, "t");
    await fetchIosRunJobs("o", "r", { ...run, run_attempt: 2 }, "t");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("取得に失敗したものは覚えない", async () => {
    let call = 0;
    const fetchMock = stub(() => {
      call += 1;
      return call === 1 ? json(500, {}) : json(200, { jobs: [job] });
    });

    expect(await fetchIosRunJobs("o", "r", run, "t")).toEqual([]);
    expect(await fetchIosRunJobs("o", "r", run, "t")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchCompletedJobAnnotations（#5438）", () => {
  it("注釈は覚えて取り直さない。取得に失敗したときは覚えない", async () => {
    let call = 0;
    const fetchMock = stub(() => {
      call += 1;
      return call === 1 ? json(500, {}) : json(200, [{ message: "更新不要", annotation_level: "notice", path: "x" }]);
    });

    expect(await fetchCompletedJobAnnotations("o", "r", 70, "t")).toEqual([]);
    const second = await fetchCompletedJobAnnotations("o", "r", 70, "t");
    const third = await fetchCompletedJobAnnotations("o", "r", 70, "t");

    expect(second).toEqual([{ message: "更新不要", annotation_level: "notice" }]);
    expect(third).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
