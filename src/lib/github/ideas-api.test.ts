import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteIdeaDirectory, listIdeaSummaries } from "@/lib/github/ideas-api";

const githubFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.test",
  githubFetch,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ideas-api", () => {
  beforeEach(() => githubFetch.mockReset());

  it("構想本文から一覧用のタイトル・状態・概要を作る", async () => {
    githubFetch
      .mockResolvedValueOnce(json([{ name: "shopping", type: "dir" }]))
      .mockResolvedValueOnce(
        json({
          content: Buffer.from("# 買い物メモ\n\n- 状態: 検討中\n\n家族で共有するメモです。\n").toString("base64"),
          encoding: "base64",
          size: 80,
        }),
      );

    await expect(listIdeaSummaries("token")).resolves.toEqual([
      expect.objectContaining({
        name: "shopping",
        title: "買い物メモ",
        state: "検討中",
        summary: "家族で共有するメモです。",
      }),
    ]);
  });

  it("構想ディレクトリ配下だけを1コミットで削除する", async () => {
    githubFetch
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(json({ object: { sha: "head" } }))
      .mockResolvedValueOnce(json({ tree: { sha: "tree" } }))
      .mockResolvedValueOnce(json({ tree: [
        { path: "ideas/shopping/README.md", type: "blob", mode: "100644" },
        { path: "ideas/shopping/screens.md", type: "blob", mode: "100755" },
        { path: "ideas/other/README.md", type: "blob", mode: "100644" },
      ] }))
      .mockResolvedValueOnce(json({ sha: "next-tree" }))
      .mockResolvedValueOnce(json({ sha: "next-commit" }))
      .mockResolvedValueOnce(json({ object: { sha: "next-commit" } }));

    await expect(deleteIdeaDirectory("token", "ideas/shopping/README.md")).resolves.toBe(true);
    expect(githubFetch).toHaveBeenCalledTimes(7);
    expect(githubFetch.mock.calls[4][2].body.tree).toEqual([
      { path: "ideas/shopping/README.md", mode: "100644", type: "blob", sha: null },
      { path: "ideas/shopping/screens.md", mode: "100755", type: "blob", sha: null },
    ]);
  });

  it("構想外のパスはGitHubへ送らない", async () => {
    await expect(deleteIdeaDirectory("token", "CLAUDE.md")).resolves.toBe(false);
    expect(githubFetch).not.toHaveBeenCalled();
  });
});
