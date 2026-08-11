import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRefCiState, resolveCiStateFromCheckRuns } from "@/lib/github/release-api";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** `page`クエリの値ごとにレスポンスを返すfetchスタブ。呼ばれたページ番号も記録する */
function stubCheckRunPages(pages: Record<number, unknown>, status = 200) {
  const requestedPages: number[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    requestedPages.push(page);
    const body = pages[page];
    if (body === undefined) return jsonResponse(404, {});
    return jsonResponse(status, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requestedPages, fetchMock };
}

function runs(count: number, run: { status: string; conclusion: string | null }) {
  return Array.from({ length: count }, () => ({ ...run }));
}

const SUCCESS = { status: "completed", conclusion: "success" };
const FAILURE = { status: "completed", conclusion: "failure" };
const RUNNING = { status: "in_progress", conclusion: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCiStateFromCheckRuns", () => {
  it("check-runsが無い場合はunknownを返す", () => {
    expect(resolveCiStateFromCheckRuns([])).toBe("unknown");
  });

  it("すべて完了して通っていればsuccessを返す", () => {
    expect(
      resolveCiStateFromCheckRuns([
        SUCCESS,
        { status: "completed", conclusion: "skipped" },
        { status: "completed", conclusion: "neutral" },
      ]),
    ).toBe("success");
  });

  it("未完了が1つでもあれば、失敗より優先してpendingを返す", () => {
    // 実行中のものがある間は結果が確定していないため、失敗が混じっていてもpending扱いにする
    expect(resolveCiStateFromCheckRuns([FAILURE, RUNNING])).toBe("pending");
  });

  it("すべて完了していて通らないものがあればfailureを返す", () => {
    expect(resolveCiStateFromCheckRuns([SUCCESS, FAILURE])).toBe("failure");
  });

  it("conclusionがnullのまま完了しているものはfailure扱いにする", () => {
    expect(resolveCiStateFromCheckRuns([{ status: "completed", conclusion: null }])).toBe("failure");
  });
});

describe("fetchRefCiState", () => {
  it("100件に収まる場合は1ページしか取得しない", async () => {
    const { requestedPages } = stubCheckRunPages({
      1: { total_count: 94, check_runs: runs(94, SUCCESS) },
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("success");
    expect(requestedPages).toEqual([1]);
  });

  it("100件を超える場合は全ページを取得し、2ページ目以降の失敗も拾う（#1061）", async () => {
    // 1ページで打ち切ると、2ページ目にある失敗を取りこぼしてsuccessを返してしまっていた
    const { requestedPages } = stubCheckRunPages({
      1: { total_count: 150, check_runs: runs(100, SUCCESS) },
      2: { total_count: 150, check_runs: [...runs(49, SUCCESS), FAILURE] },
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("failure");
    expect(requestedPages.sort()).toEqual([1, 2]);
  });

  it("2ページ目以降にpendingがあればpendingを返す", async () => {
    stubCheckRunPages({
      1: { total_count: 150, check_runs: runs(100, SUCCESS) },
      2: { total_count: 150, check_runs: [...runs(49, FAILURE), RUNNING] },
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("pending");
  });

  it("2ページ目の取得に失敗した場合は部分的な結果で判定せずunknownを返す", async () => {
    // 欠けたページに失敗があるかもしれないため、successと誤って返さない
    stubCheckRunPages({
      1: { total_count: 150, check_runs: runs(100, SUCCESS) },
      // page=2 は未定義なので404を返す
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("unknown");
  });

  it("1ページ目の取得に失敗した場合はunknownを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("unknown");
  });

  it("取得ページ数には上限があり、際限なく問い合わせない", async () => {
    const pages: Record<number, unknown> = {};
    for (let page = 1; page <= 30; page += 1) {
      pages[page] = { total_count: 3000, check_runs: runs(100, SUCCESS) };
    }
    const { requestedPages } = stubCheckRunPages(pages);

    await fetchRefCiState("owner", "repo", "develop", "token");

    expect(requestedPages).toHaveLength(10);
  });
});
