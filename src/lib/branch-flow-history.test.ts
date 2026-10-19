import { describe, expect, it, vi } from "vitest";

import {
  fetchBranchFlowHistoryPage,
  hasMoreHistory,
  HISTORY_MAX_MAIN_PAGES_PER_LOAD,
  INITIAL_HISTORY_CURSOR,
  mergeHistoryPullRequests,
  nextHistoryPage,
  shouldFetchMoreMain,
} from "@/lib/branch-flow-history";
import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";
import type { PullRequestSummary } from "@/types/pull-request";

function apiPullRequest(number: number, createdAt: string): GithubApiOpenPullRequest {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    body: null,
    draft: false,
    state: "closed",
    created_at: createdAt,
    updated_at: createdAt,
    merged_at: createdAt,
    user: null,
    base: { ref: "develop" },
    head: { ref: `issue-${number}`, sha: "0" },
    auto_merge: null,
  };
}

function page(count: number, startNumber: number, createdAt: string): GithubApiOpenPullRequest[] {
  return Array.from({ length: count }, (_, index) => apiPullRequest(startNumber - index, createdAt));
}

describe("nextHistoryPage", () => {
  it("上限件数と同数なら次のページへ、少なければ取り切り", () => {
    expect(nextHistoryPage(1, 100, 100)).toBe(2);
    expect(nextHistoryPage(2, 99, 100)).toBeNull();
    expect(nextHistoryPage(3, 0, 100)).toBeNull();
  });

  it("どちらかの向きに続きがあれば続きあり", () => {
    expect(hasMoreHistory(INITIAL_HISTORY_CURSOR)).toBe(true);
    expect(hasMoreHistory({ developPage: null, mainPage: 4 })).toBe(true);
    expect(hasMoreHistory({ developPage: null, mainPage: null })).toBe(false);
  });
});

describe("shouldFetchMoreMain", () => {
  it("main宛の最古がdevelop宛の最古より新しい間だけ取り足す", () => {
    expect(
      shouldFetchMoreMain({
        developOldestCreatedAt: "2026-08-01T00:00:00Z",
        mainOldestCreatedAt: "2026-08-05T00:00:00Z",
        fetchedMainPages: 1,
      }),
    ).toBe(true);
    expect(
      shouldFetchMoreMain({
        developOldestCreatedAt: "2026-08-01T00:00:00Z",
        mainOldestCreatedAt: "2026-07-20T00:00:00Z",
        fetchedMainPages: 0,
      }),
    ).toBe(false);
  });

  it("1押下あたりの上限を超えては取らない", () => {
    expect(
      shouldFetchMoreMain({
        developOldestCreatedAt: "2026-08-01T00:00:00Z",
        mainOldestCreatedAt: "2026-08-05T00:00:00Z",
        fetchedMainPages: HISTORY_MAX_MAIN_PAGES_PER_LOAD,
      }),
    ).toBe(false);
  });

  it("develop宛を取らなかった押下では、main宛を1ページだけ進める", () => {
    const input = { developOldestCreatedAt: null, mainOldestCreatedAt: "2026-08-05T00:00:00Z" };
    expect(shouldFetchMoreMain({ ...input, fetchedMainPages: 0 })).toBe(true);
    expect(shouldFetchMoreMain({ ...input, fetchedMainPages: 1 })).toBe(false);
  });
});

describe("fetchBranchFlowHistoryPage", () => {
  it("develop宛1ページと、同じ深さまでのmain宛を取り、次のページ番号を返す", async () => {
    const fetchPage = vi.fn(async (base: "develop" | "main", pageNumber: number) => {
      if (base === "develop") return page(100, 1000, "2026-08-01T00:00:00Z");
      // 1ページ目はまだdevelop宛より新しく、2ページ目で追い越す
      return pageNumber === 1 ? page(100, 900, "2026-08-10T00:00:00Z") : page(100, 800, "2026-07-01T00:00:00Z");
    });

    const result = await fetchBranchFlowHistoryPage({
      cursor: INITIAL_HISTORY_CURSOR,
      mainOldestCreatedAt: null,
      perPage: 100,
      fetchPage,
    });

    expect(fetchPage.mock.calls).toEqual([
      ["develop", 1],
      ["main", 1],
      ["main", 2],
    ]);
    expect(result.pullRequests).toHaveLength(300);
    expect(result.cursor).toEqual({ developPage: 2, mainPage: 3 });
    expect(result.mainOldestCreatedAt).toBe("2026-07-01T00:00:00Z");
  });

  it("main宛が既に十分古ければ、develop宛の1リクエストで済ませる", async () => {
    const fetchPage = vi.fn(async () => page(100, 1000, "2026-08-01T00:00:00Z"));
    const result = await fetchBranchFlowHistoryPage({
      cursor: { developPage: 2, mainPage: 3 },
      mainOldestCreatedAt: "2026-07-01T00:00:00Z",
      perPage: 100,
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.cursor).toEqual({ developPage: 3, mainPage: 3 });
  });

  it("両方の向きを取り切ったら続きが無くなる", async () => {
    const fetchPage = vi.fn(async (base: "develop" | "main") =>
      base === "develop" ? page(3, 10, "2026-08-01T00:00:00Z") : page(1, 5, "2026-07-01T00:00:00Z"),
    );
    const result = await fetchBranchFlowHistoryPage({
      cursor: INITIAL_HISTORY_CURSOR,
      mainOldestCreatedAt: null,
      perPage: 100,
      fetchPage,
    });
    expect(hasMoreHistory(result.cursor)).toBe(false);
  });
});

describe("mergeHistoryPullRequests", () => {
  const summary = (repositoryFullName: string, number: number, title = `PR ${number}`) =>
    ({ repositoryFullName, number, title }) as PullRequestSummary;

  it("リポジトリと番号で重ね、同じPRは母集団の側を残す", () => {
    const base = [summary("o/r", 10, "最新"), summary("o/r", 9)];
    const merged = mergeHistoryPullRequests(base, [
      summary("o/r", 10, "古い取得"),
      summary("o/r", 8),
      summary("o/r", 8),
      summary("o/other", 10),
    ]);
    expect(merged.map((pullRequest) => `${pullRequest.repositoryFullName}#${pullRequest.number}`)).toEqual([
      "o/r#10",
      "o/r#9",
      "o/r#8",
      "o/other#10",
    ]);
    expect(merged[0].title).toBe("最新");
  });

  it("追加分が無ければ母集団をそのまま返す", () => {
    const base = [summary("o/r", 10)];
    expect(mergeHistoryPullRequests(base, [])).toBe(base);
  });
});
