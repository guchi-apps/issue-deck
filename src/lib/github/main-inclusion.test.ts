import { beforeEach, describe, expect, it, vi } from "vitest";

const githubGraphql = vi.fn();
vi.mock("@/lib/github/graphql", () => ({ githubGraphql: (...args: unknown[]) => githubGraphql(...args) }));

import {
  classifyByBlobs,
  clearMainInclusionMemoForTest,
  pickedPullRequestNumbers,
  resolveMainInclusion,
} from "@/lib/github/main-inclusion";

const base = { owner: "o", repo: "r", token: "t", mainOid: "main", developOid: "dev", picked: new Set<number>() };

describe("pickedPullRequestNumbers", () => {
  it("親が1つで件名がPRマージのコミットだけを選択適用の痕跡として拾う", () => {
    const picked = pickedPullRequestNumbers([
      { messageHeadline: "Merge pull request #4511 from guchi-apps/fix/x", parents: { totalCount: 1 } },
      { messageHeadline: "Merge pull request #4507 from guchi-apps/release-main/v8", parents: { totalCount: 2 } },
      { messageHeadline: "v8.56.1をリリースする。", parents: { totalCount: 1 } },
    ]);
    expect([...picked]).toEqual([4511]);
  });
});

describe("classifyByBlobs", () => {
  it("全ファイル一致なら反映済み、一部なら部分適用、無一致なら未反映、不明なら不明", () => {
    expect(classifyByBlobs([{ mainOid: "a", developOid: "a" }, { mainOid: null, developOid: null }])).toBe("included");
    expect(classifyByBlobs([{ mainOid: "a", developOid: "a" }, { mainOid: "b", developOid: "c" }])).toBe("partial");
    expect(classifyByBlobs([{ mainOid: "b", developOid: "c" }])).toBe("not-included");
    expect(classifyByBlobs([])).toBe("unknown");
    expect(classifyByBlobs(null)).toBe("unknown");
  });
});

describe("resolveMainInclusion", () => {
  beforeEach(() => {
    githubGraphql.mockReset();
    clearMainInclusionMemoForTest();
  });

  it("cherry-pick済みは照合せず反映済み。ファイル一致のPRは反映済み、不一致は未反映として残す", async () => {
    githubGraphql
      .mockResolvedValueOnce({
        repository: {
          p0: { files: { totalCount: 1, nodes: [{ path: "a.ts" }] } },
          p1: { files: { totalCount: 1, nodes: [{ path: "b.ts" }] } },
        },
      })
      .mockResolvedValueOnce({
        repository: { m0: { oid: "x" }, d0: { oid: "x" }, m1: { oid: "old" }, d1: { oid: "new" } },
      });
    const result = await resolveMainInclusion({ ...base, pullRequestNumbers: [4511, 4516, 4512], picked: new Set([4511]) });
    expect(result.get(4511)).toEqual({ state: "included", evidence: "cherry-pick" });
    expect(result.get(4516)).toEqual({ state: "included", evidence: "content" });
    expect(result.get(4512)).toEqual({ state: "not-included", evidence: null });
  });

  it("ファイルが多すぎる・取得に失敗した場合は反映済みと断定せず不明にする", async () => {
    githubGraphql.mockResolvedValueOnce({ repository: { p0: { files: { totalCount: 200, nodes: [{ path: "a" }] } } } });
    // 全PRが照合不能ならblob取得は走らない
    expect((await resolveMainInclusion({ ...base, pullRequestNumbers: [1] })).get(1)?.state).toBe("unknown");
    githubGraphql.mockRejectedValueOnce(new Error("boom"));
    expect((await resolveMainInclusion({ ...base, pullRequestNumbers: [2] })).get(2)).toEqual({ state: "unknown", evidence: null });
  });

  it("同じmain・develop・PRの組は覚えて問い合わせない（#5438）", async () => {
    githubGraphql
      .mockResolvedValueOnce({ repository: { p0: { files: { totalCount: 1, nodes: [{ path: "a.ts" }] } } } })
      .mockResolvedValueOnce({ repository: { m0: { oid: "x" }, d0: { oid: "x" } } });
    const first = await resolveMainInclusion({ ...base, pullRequestNumbers: [7] });
    const second = await resolveMainInclusion({ ...base, pullRequestNumbers: [7] });
    expect(second).toEqual(first);
    expect(second.get(7)).toEqual({ state: "included", evidence: "content" });
    expect(githubGraphql).toHaveBeenCalledTimes(2);

    // developが進めば別の組なので問い合わせ直す
    githubGraphql.mockRejectedValueOnce(new Error("boom"));
    await resolveMainInclusion({ ...base, developOid: "other-develop", pullRequestNumbers: [7] });
    expect(githubGraphql).toHaveBeenCalledTimes(3);
  });

  it("不明（取得失敗）を含む結果は覚えず、次の呼び出しで問い合わせ直す", async () => {
    githubGraphql.mockRejectedValueOnce(new Error("boom"));
    expect((await resolveMainInclusion({ ...base, pullRequestNumbers: [8] })).get(8)?.state).toBe("unknown");
    githubGraphql
      .mockResolvedValueOnce({ repository: { p0: { files: { totalCount: 1, nodes: [{ path: "a.ts" }] } } } })
      .mockResolvedValueOnce({ repository: { m0: { oid: "x" }, d0: { oid: "y" } } });
    expect((await resolveMainInclusion({ ...base, pullRequestNumbers: [8] })).get(8)?.state).toBe("not-included");
    expect(githubGraphql).toHaveBeenCalledTimes(3);
  });
});
