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
        comparison: {
          compare: {
            aheadBy: 12,
            behindBy: 0,
            baseTarget: { tree: { oid: "tree-main" } },
            headTarget: { tree: { oid: "tree-develop" } },
          },
        },
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
    expect(result.developVsMain).toEqual({ aheadBy: 12, behindBy: 0, sameContent: false });
  });

  // #2316。バンプPRを`develop`へマージしたときのマージコミットが残っている状態
  it("treeが一致すればsameContentをtrueで返す（差分ゼロのコミットが残っている状態）", async () => {
    stubGraphql({
      repository: {
        comparison: {
          compare: {
            aheadBy: 1,
            behindBy: 24,
            baseTarget: { tree: { oid: "same-tree" } },
            headTarget: { tree: { oid: "same-tree" } },
          },
        },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "aide", [], "token");

    expect(result.developVsMain).toEqual({ aheadBy: 1, behindBy: 24, sameContent: true });
  });

  // tree OIDが取れないときに「差分なし」へ倒すと、出すものがあるのにリリースを止めてしまう
  it("tree OIDが取れなければsameContentはfalse", async () => {
    stubGraphql({
      repository: {
        comparison: { compare: { aheadBy: 3, behindBy: 0, baseTarget: null, headTarget: null } },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "aide", [], "token");

    expect(result.developVsMain).toEqual({ aheadBy: 3, behindBy: 0, sameContent: false });
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
