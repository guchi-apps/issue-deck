import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupBranchRefs } from "@/lib/github/branches-api";

type GraphqlRequest = { query: string; variables: Record<string, unknown> };

/** GraphQLの応答を返すfetchスタブ。送った本文も記録する */
function stubGraphql(data: unknown) {
  const requests: GraphqlRequest[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupBranchRefs", () => {
  it("問い合わせたブランチのうち実在するものだけを返す", async () => {
    stubGraphql({
      repository: {
        comparison: { compare: { aheadBy: 12, behindBy: 0 } },
        b0: { name: "issue-1455" },
        b1: null,
      },
    });

    const result = await lookupBranchRefs(
      "guchi-apps",
      "issue-deck",
      ["issue-1455", "issue-1470"],
      "token",
    );

    expect(result.existingBranches).toEqual(["issue-1455"]);
    expect(result.developVsMain).toEqual({ aheadBy: 12, behindBy: 0 });
  });

  it("ブランチ名はクエリ本文へ埋め込まず、GraphQLの変数として渡す", async () => {
    const { requests, fetchMock } = stubGraphql({
      repository: { comparison: null, b0: null },
    });

    await lookupBranchRefs("guchi-apps", "issue-deck", ['weird") { x } #'], "token");

    // リポジトリあたり1リクエストで済ませる（この画面の取得コストの前提）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request] = requests;
    expect(request.query).not.toContain("weird");
    expect(request.variables.b0).toBe('refs/heads/weird") { x } #');
  });

  it("main・developが無いリポジトリでは差分をnullで返す", async () => {
    stubGraphql({ repository: { comparison: null } });

    const result = await lookupBranchRefs("guchi-apps", "other", [], "token");

    expect(result).toEqual({ existingBranches: [], developVsMain: null });
  });

  it("リポジトリが見つからない応答でも落ちない", async () => {
    stubGraphql({ repository: null });

    const result = await lookupBranchRefs("guchi-apps", "missing", ["issue-1"], "token");

    expect(result).toEqual({ existingBranches: [], developVsMain: null });
  });
});
