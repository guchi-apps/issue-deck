import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRefCiState, resolveCiStateFromCheckRuns } from "@/lib/github/release-api";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** `statusCheckRollup`のGraphQL応答を返すfetchスタブ。呼ばれた回数も記録する */
function stubRollup(
  rollup: { state: string | null; totalCount: number; nodes: unknown[] } | null,
  status = 200,
) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    requestedUrls.push(url);
    return jsonResponse(status, {
      data: {
        repository: {
          object: rollup
            ? {
                statusCheckRollup: {
                  state: rollup.state,
                  contexts: { totalCount: rollup.totalCount, nodes: rollup.nodes },
                },
              }
            : { statusCheckRollup: null },
        },
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requestedUrls };
}

/** rollupのCheckRunノード（GraphQLは大文字の列挙で返す） */
function checkRun(status: string, conclusion: string | null) {
  return { __typename: "CheckRun", status, conclusion };
}

function checkRuns(count: number, status: string, conclusion: string | null) {
  return Array.from({ length: count }, () => checkRun(status, conclusion));
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
  it("GitHubがChecksとして数えるチェックだけを見る（#1578）", async () => {
    // RESTのcheck-runsと違い、rollupには無人実行のワークフローのジョブが入らない。
    // developのheadに無関係なキャンセル・実行中が積まれていても、CIが通っていればsuccess。
    const { requestedUrls } = stubRollup({
      state: "SUCCESS",
      totalCount: 5,
      nodes: [...checkRuns(4, "COMPLETED", "SUCCESS"), checkRun("COMPLETED", "SKIPPED")],
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("success");
    // 問い合わせはGraphQL1回だけ（RESTのページングをしない）
    expect(requestedUrls).toEqual(["https://api.github.com/graphql"]);
  });

  it("失敗したチェックがあればfailureを返す", async () => {
    stubRollup({
      state: "FAILURE",
      totalCount: 2,
      nodes: [checkRun("COMPLETED", "SUCCESS"), checkRun("COMPLETED", "FAILURE")],
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("failure");
  });

  it("実行中のチェックがあれば、失敗より優先してpendingを返す", async () => {
    // GitHubの`state`はこの場合FAILUREになるが、issue-deckは確定するまでpendingで扱う（#1433）
    stubRollup({
      state: "FAILURE",
      totalCount: 2,
      nodes: [checkRun("COMPLETED", "FAILURE"), checkRun("IN_PROGRESS", null)],
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("pending");
  });

  it("外部CIのcommit status（StatusContext）も数える", async () => {
    stubRollup({
      state: "FAILURE",
      totalCount: 2,
      nodes: [checkRun("COMPLETED", "SUCCESS"), { __typename: "StatusContext", state: "FAILURE" }],
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("failure");
  });

  it("チェックが100件を超える場合はGitHubの集約値をそのまま使う", async () => {
    // 1件ずつ見られないぶん、ページングを重ねずGitHub自身の判定へ委ねる
    stubRollup({
      state: "FAILURE",
      totalCount: 120,
      nodes: checkRuns(100, "COMPLETED", "SUCCESS"),
    });

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("failure");
  });

  it("チェックが1件も無い場合はunknownを返す", async () => {
    stubRollup(null);

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("unknown");
  });

  it("取得に失敗した場合はunknownを返す", async () => {
    // 取得できないだけで「失敗」にはしない（マージの導線を消さないため）
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));

    await expect(fetchRefCiState("owner", "repo", "develop", "token")).resolves.toBe("unknown");
  });
});
