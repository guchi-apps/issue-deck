import { beforeEach, describe, expect, it, vi } from "vitest";

const githubGraphql = vi.fn();
vi.mock("@/lib/github/graphql", () => ({ githubGraphql: (...args: unknown[]) => githubGraphql(...args) }));

import { fetchOpenPromotionPullRequests } from "@/lib/github/knowledge-api";

function pullRequest(files: { path: string; changeType: string }[]) {
  return {
    number: 138,
    title: "共有知見を反映",
    url: "https://github.com/guchi-apps/docs/pull/138",
    createdAt: "2026-09-18T22:36:56Z",
    headRefName: "knowledge/promote-20260918-223656",
    body: "本文",
    baseRefOid: "base-tip",
    headRefOid: "head-oid",
    commits: { nodes: [{ commit: { parents: { nodes: [{ oid: "fork-point" }] } } }] },
    files: { nodes: files.map((f) => ({ ...f, additions: 3, deletions: 0 })) },
  };
}

function prList(...nodes: ReturnType<typeof pullRequest>[]) {
  return { repository: { pullRequests: { nodes } } };
}

describe("fetchOpenPromotionPullRequests（反映PRの変更ファイル）", () => {
  beforeEach(() => githubGraphql.mockReset());

  it("比較元はbaseブランチの先端ではなくPRの最初のコミットの親にする", async () => {
    githubGraphql
      .mockResolvedValueOnce(prList(pullRequest([{ path: "knowledge/a.md", changeType: "MODIFIED" }])))
      .mockResolvedValueOnce({
        repository: { b0: { text: "## A\n" }, h0: { text: "## A\n## B\n" } },
      });

    const [pr] = await fetchOpenPromotionPullRequests("token");

    const variables = githubGraphql.mock.calls[1][2] as Record<string, string>;
    expect(variables.b0).toBe("fork-point:knowledge/a.md");
    expect(variables.h0).toBe("head-oid:knowledge/a.md");
    expect(pr.files[0].texts).toEqual({ base: "## A\n", head: "## A\n## B\n" });
  });

  it("新規ファイルの比較元が無い（null）のは失敗ではなく、空文字として扱う", async () => {
    githubGraphql
      .mockResolvedValueOnce(prList(pullRequest([{ path: "knowledge/new.md", changeType: "ADDED" }])))
      .mockResolvedValueOnce({ repository: { b0: null, h0: { text: "## 新規\n" } } });

    const [pr] = await fetchOpenPromotionPullRequests("token");
    expect(pr.files[0].texts).toEqual({ base: "", head: "## 新規\n" });
  });

  it("既存ファイルなのに比較元が取れなければ、読めなかった扱い（全部「追加」に見せない）", async () => {
    githubGraphql
      .mockResolvedValueOnce(prList(pullRequest([{ path: "knowledge/a.md", changeType: "MODIFIED" }])))
      .mockResolvedValueOnce({ repository: { b0: null, h0: { text: "## A\n" } } });

    const [pr] = await fetchOpenPromotionPullRequests("token");
    expect(pr.files[0].texts).toBeNull();
  });

  it("切り詰められた本文は読めなかった扱いにする", async () => {
    githubGraphql
      .mockResolvedValueOnce(prList(pullRequest([{ path: "knowledge/a.md", changeType: "MODIFIED" }])))
      .mockResolvedValueOnce({
        repository: { b0: { text: "## A\n" }, h0: { text: "## A\n", isTruncated: true } },
      });

    const [pr] = await fetchOpenPromotionPullRequests("token");
    expect(pr.files[0].texts).toBeNull();
  });

  it("本文の取得に失敗しても、PRは落とさず行数だけの形で返す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    githubGraphql
      .mockResolvedValueOnce(prList(pullRequest([{ path: "knowledge/a.md", changeType: "MODIFIED" }])))
      .mockRejectedValueOnce(new Error("boom"));

    const result = await fetchOpenPromotionPullRequests("token");
    expect(result).toHaveLength(1);
    expect(result[0].files).toEqual([
      { path: "knowledge/a.md", changeType: "MODIFIED", additions: 3, deletions: 0, texts: null },
    ]);
  });

  it("knowledge/*.md が無い（README.mdだけ等の）PRは本文を取りに行かない", async () => {
    githubGraphql.mockResolvedValueOnce(
      prList(pullRequest([{ path: "knowledge/README.md", changeType: "MODIFIED" }])),
    );

    await fetchOpenPromotionPullRequests("token");
    expect(githubGraphql).toHaveBeenCalledTimes(1);
  });

  it("反映PRのブランチ名でないPRは除く", async () => {
    githubGraphql.mockResolvedValueOnce(
      prList({ ...pullRequest([]), headRefName: "feature/x" }),
    );
    expect(await fetchOpenPromotionPullRequests("token")).toEqual([]);
  });
});
