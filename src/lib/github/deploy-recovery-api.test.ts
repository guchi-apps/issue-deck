import { describe, expect, it, vi } from "vitest";

const githubFetch = vi.fn();

vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  get githubFetch() {
    return githubFetch;
  },
}));

import {
  createDeployRecoveryPullRequest,
  DeployRecoveryConflictError,
  fetchDeployRecoveryCandidates,
  isDependencyFile,
  nextPatchVersion,
} from "@/lib/github/deploy-recovery-api";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function candidatesResponses(url: string) {
  if (url.includes("/compare/")) return response({ commits: [{ sha: "merge-2" }, { sha: "merge-1" }], total_commits: 2 });
  if (url.includes("state=closed")) {
    return response([
      { number: 2, title: "後の修正", html_url: "https://example.test/2", merged_at: "2026-10-02T00:00:00Z", merge_commit_sha: "merge-2", base: { ref: "develop" } },
      { number: 1, title: "先の修正", html_url: "https://example.test/1", merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: "merge-1", base: { ref: "develop" } },
    ]);
  }
  return null;
}

describe("deploy recovery GitHub API（#3913）", () => {
  it("main未反映のPRをマージ時刻順に返す", async () => {
    githubFetch.mockReset().mockImplementation(async (url: string) => candidatesResponses(url));

    const candidates = await fetchDeployRecoveryCandidates("guchi-apps", "issue-deck", "token");

    expect(candidates.candidates.map((candidate) => candidate.number)).toEqual([1, 2]);
    expect(candidates.truncated).toBe(false);
  });

  it("比較コミットが取得上限を超えると候補が欠ける可能性を返す", async () => {
    githubFetch.mockReset().mockImplementation(async (url: string) => {
      if (url.includes("/compare/")) return response({ commits: [{ sha: "merge-1" }], total_commits: 251 });
      if (url.includes("state=closed")) return response([]);
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(fetchDeployRecoveryCandidates("guchi-apps", "issue-deck", "token")).resolves.toMatchObject({
      candidates: [],
      truncated: true,
    });
  });

  function gitFixture(overrides: { headBlob?: string } = {}) {
    const trees: Record<string, Array<{ path: string; mode: string; type: string; sha: string }>> = {
      "tree-main": [{ path: "a.ts", mode: "100644", type: "blob", sha: overrides.headBlob ?? "a0" }, { path: "package.json", mode: "100644", type: "blob", sha: "pkg0" }],
      "tree-base": [{ path: "a.ts", mode: "100644", type: "blob", sha: "a0" }, { path: "package.json", mode: "100644", type: "blob", sha: "pkg0" }],
      "tree-merged": [{ path: "a.ts", mode: "100644", type: "blob", sha: "a1" }, { path: "package.json", mode: "100644", type: "blob", sha: "pkg0" }],
    };
    const created: string[] = [];
    return async (url: string, _token: string, options?: { method?: string; body?: unknown }) => {
      const candidates = candidatesResponses(url);
      if (candidates) return candidates;
      if (url.includes("state=open")) return response([]);
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: "main-sha" } });
      if (url.endsWith("/git/refs")) return response({}, 201);
      if (url.endsWith("/git/commits/main-sha")) return response({ sha: "main-sha", tree: { sha: "tree-main" } });
      if (url.endsWith("/git/commits/base-sha")) return response({ sha: "base-sha", tree: { sha: "tree-base" } });
      if (url.includes("/git/commits/merge-")) return response({ sha: "m", tree: { sha: "tree-merged" } });
      if (/\/git\/commits\/new-/.test(url)) return response({ sha: "n", tree: { sha: "tree-main" } });
      if (url.includes("/git/trees/tree-")) {
        const key = url.split("/git/trees/")[1].split("?")[0];
        return response({ truncated: false, tree: trees[key] });
      }
      if (/\/commits\/merge-\d/.test(url)) return response({ parents: [{ sha: "base-sha" }], files: [{ filename: "a.ts", status: "modified", sha: "a1" }] });
      if (url.endsWith("/tags?per_page=100")) return response([{ name: "v8.34.1" }, { name: "v8.34.2" }]);
      if (url.includes("/git/blobs/pkg0")) return response({ encoding: "utf-8", content: '{"version": "8.34.1"}' });
      if (url.endsWith("/git/blobs")) return response({ sha: "pkg1" }, 201);
      if (url.endsWith("/git/trees") && options?.method === "POST") { created.push(JSON.stringify(options.body)); return response({ sha: "new-tree" }, 201); }
      if (url.endsWith("/git/commits") && options?.method === "POST") return response({ sha: `new-${created.length}` }, 201);
      if (url.includes("/git/refs/heads/deploy-recovery/") && options?.method === "PATCH") return response({}, 200);
      if (url.includes("/git/refs/heads/deploy-recovery/") && options?.method === "DELETE") return response({}, 204);
      if (url.endsWith("/pulls") && options?.method === "POST") return response({ html_url: "https://example.test/pull/9" }, 201);
      throw new Error(`unexpected request: ${url}`);
    };
  }

  it("選択PRのマージ差分だけをmain起点のブランチへ適用し、版を上げて復旧用PRを作る", async () => {
    githubFetch.mockReset().mockImplementation(gitFixture());

    await expect(createDeployRecoveryPullRequest("guchi-apps", "issue-deck", "token", [1])).resolves.toEqual({ url: "https://example.test/pull/9" });

    expect(githubFetch.mock.calls.some(([url]) => String(url).endsWith("/merges"))).toBe(false);
    const blob = githubFetch.mock.calls.find(([url, , options]) => String(url).endsWith("/git/blobs") && (options as { method?: string })?.method === "POST");
    expect((blob?.[2] as { body: { content: string } }).body.content).toContain("8.34.3");
    const pull = githubFetch.mock.calls.find(([url, , options]) => String(url).endsWith("/pulls") && (options as { method?: string })?.method === "POST");
    expect((pull?.[2] as { body: { body: string } }).body.body).toContain("8.34.3");
  });

  it("未選択のdevelop変更と同じファイルを変えているPRは理由付きで止め、途中ブランチを削除する", async () => {
    githubFetch.mockReset().mockImplementation(gitFixture({ headBlob: "other" }));

    await expect(createDeployRecoveryPullRequest("guchi-apps", "issue-deck", "token", [1])).rejects.toBeInstanceOf(DeployRecoveryConflictError);
    expect(githubFetch.mock.calls.some(([url, , options]) => String(url).includes("/git/refs/heads/deploy-recovery/") && (options as { method?: string }).method === "DELETE")).toBe(true);
    expect(githubFetch.mock.calls.some(([url, , options]) => String(url).endsWith("/pulls") && (options as { method?: string })?.method === "POST")).toBe(false);
  });
});

describe("版の採番", () => {
  it("既存タグを飛ばして次のパッチ版を返す", () => {
    expect(nextPatchVersion("8.34.1", new Set(["8.34.2"]))).toBe("8.34.3");
  });
  it("依存関係ファイルを判定する", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("src/a.ts")).toBe(false);
  });
});
