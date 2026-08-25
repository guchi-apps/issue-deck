import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupBranchRefs, mergedHeadRefFromHeadline } from "@/lib/github/branches-api";

type GraphqlRequest = { query: string; variables: Record<string, unknown> };

/** GraphQLの応答を返すfetchスタブ。送った本文も記録する */
function stubGraphql(data: unknown, errors?: unknown[]) {
  const requests: GraphqlRequest[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => (errors ? { data, errors } : { data }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** GraphQLの`commits.nodes`の1件（#2333） */
function commit(oid: string, messageHeadline: string, parents: string[]) {
  return {
    oid,
    messageHeadline,
    parents: { totalCount: parents.length, nodes: parents.map((parent) => ({ oid: parent })) },
  };
}

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
    expect(result.developVsMain).toEqual({ aheadBy: 12, behindBy: 0, sameContent: false, units: null });
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

    expect(result.developVsMain).toEqual({ aheadBy: 1, behindBy: 24, sameContent: true, units: null });
  });

  // tree OIDが取れないときに「差分なし」へ倒すと、出すものがあるのにリリースを止めてしまう
  it("tree OIDが取れなければsameContentはfalse", async () => {
    stubGraphql({
      repository: {
        comparison: { compare: { aheadBy: 3, behindBy: 0, baseTarget: null, headTarget: null } },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "aide", [], "token");

    expect(result.developVsMain).toEqual({ aheadBy: 3, behindBy: 0, sameContent: false, units: null });
  });

  // #2333。PR 2件のマージ（マージコミット2個＋作業コミット2個）とバンプPRのマージ1個で
  // 5コミット、という#2324で実際に見えていた状態
  it("マージコミット単位で数え、バージョンバンプのマージは別枠にする", async () => {
    stubGraphql({
      repository: {
        comparison: {
          compare: {
            aheadBy: 5,
            behindBy: 0,
            baseTarget: { tree: { oid: "tree-main" } },
            headTarget: { oid: "merge-2323", tree: { oid: "tree-develop" } },
            commits: {
              totalCount: 5,
              nodes: [
                commit("merge-bump", "Merge pull request #2320 from guchi-apps/release/v4.41.0", [
                  "main-tip",
                  "bump-work",
                ]),
                commit("work-a", "#2294の確認で出た2つの誤判定の元を書き込む。", ["main-tip"]),
                commit("merge-2322", "Merge pull request #2322 from guchi-apps/issue-2298", [
                  "merge-bump",
                  "work-a",
                ]),
                commit("work-b", "poller更新の手順を寄せる。", ["merge-2322"]),
                commit("merge-2323", "Merge pull request #2323 from guchi-apps/issue-2298", [
                  "merge-2322",
                  "work-b",
                ]),
              ],
            },
          },
        },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "issue-deck", [], "token");

    expect(result.developVsMain?.aheadBy).toBe(5);
    expect(result.developVsMain?.units).toEqual({
      mergeCount: 2,
      directCount: 0,
      versionBumpCount: 1,
    });
  });

  // squash mergeのリポジトリではマージコミットが残らない。1PR＝1コミットなので
  // first-parentの列がそのままPRの件数になる
  it("マージコミットが無ければ幹のコミットをそのまま数える", async () => {
    stubGraphql({
      repository: {
        comparison: {
          compare: {
            aheadBy: 2,
            behindBy: 0,
            baseTarget: { tree: { oid: "tree-main" } },
            headTarget: { oid: "squash-2", tree: { oid: "tree-develop" } },
            commits: {
              totalCount: 2,
              nodes: [
                commit("squash-1", "画面の文言を直す (#12)", ["main-tip"]),
                commit("squash-2", "取得の失敗を握りつぶさない (#13)", ["squash-1"]),
              ],
            },
          },
        },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "other", [], "token");

    expect(result.developVsMain?.units).toEqual({
      mergeCount: 0,
      directCount: 2,
      versionBumpCount: 0,
    });
  });

  // 数え落としたまま「◯件」と言い切らない。取れなければコミット数へ落とす
  it("コミット一覧が取得上限を超えていればunitsをnullにする", async () => {
    stubGraphql({
      repository: {
        comparison: {
          compare: {
            aheadBy: 120,
            behindBy: 0,
            baseTarget: { tree: { oid: "tree-main" } },
            headTarget: { oid: "head", tree: { oid: "tree-develop" } },
            commits: {
              totalCount: 120,
              nodes: [commit("head", "直近のコミット", ["one-before"])],
            },
          },
        },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "other", [], "token");

    expect(result.developVsMain?.units).toBeNull();
  });

  it("headのOIDが読めなければunitsをnullにする", async () => {
    stubGraphql({
      repository: {
        comparison: {
          compare: {
            aheadBy: 1,
            behindBy: 0,
            baseTarget: { tree: { oid: "tree-main" } },
            headTarget: { tree: { oid: "tree-develop" } },
            commits: { totalCount: 1, nodes: [commit("only", "1件だけ", ["main-tip"])] },
          },
        },
      },
    });

    const result = await lookupBranchRefs("guchi-apps", "other", [], "token");

    expect(result.developVsMain?.units).toBeNull();
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

  // #2364。単一ブランチ運用のリポジトリで毎回のポーリングが失敗し、本番のログが埋まっていた
  it("developが無くcompareだけが落ちた応答でも、ブランチの存在確認は返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubGraphql(
      { repository: { comparison: { compare: null }, b0: { name: "issue-2364" }, b1: null } },
      [
        {
          type: "NOT_FOUND",
          path: ["repository", "comparison", "compare"],
          message: "Could not resolve head ref 'develop'.",
        },
      ],
    );

    const result = await lookupBranchRefs(
      "guchi-apps",
      "docs",
      ["issue-2364", "issue-9999"],
      "token",
    );

    expect(result).toEqual({ existingBranches: ["issue-2364"], developVsMain: null });
    // 正常な状態なので警告も出さない（ポーリングのたびにログへ出るのを避けるのが目的）
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // 無視するのは`compare`が解決できなかったときだけ。他の失敗は従来どおり取得失敗にする
  it("compare以外のエラーは従来どおり例外にする", async () => {
    stubGraphql({ repository: null }, [{ message: "Resource not accessible by integration" }]);

    await expect(lookupBranchRefs("guchi-apps", "docs", ["issue-1"], "token")).rejects.toThrow(
      /Resource not accessible by integration/,
    );
  });
});

// #2333。バンプのマージを件数の本体から外せるかがこの読み取りだけに掛かっている
describe("mergedHeadRefFromHeadline", () => {
  it("GitHubのマージボタンのメッセージからブランチ名を読む", () => {
    expect(
      mergedHeadRefFromHeadline("Merge pull request #2320 from guchi-apps/release/v4.41.0"),
    ).toBe("release/v4.41.0");
    expect(
      mergedHeadRefFromHeadline("Merge pull request #2322 from guchi-apps/issue-2298"),
    ).toBe("issue-2298");
  });

  it("手元での`git merge`のメッセージからも読む", () => {
    expect(mergedHeadRefFromHeadline("Merge branch 'release/v1.2.3' into develop")).toBe(
      "release/v1.2.3",
    );
  });

  it("マージコミットでないメッセージからは読まない", () => {
    expect(mergedHeadRefFromHeadline("画面の文言を直す。")).toBeNull();
  });
});
