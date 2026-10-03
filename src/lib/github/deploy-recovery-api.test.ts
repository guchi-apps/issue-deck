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

  it("選択PRをmain起点のブランチへ順に取り込み、復旧用PRを作る", async () => {
    githubFetch.mockReset().mockImplementation(async (url: string, _token: string, options?: { method?: string; body?: unknown }) => {
      const candidates = candidatesResponses(url);
      if (candidates) return candidates;
      if (url.includes("state=open")) return response([]);
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: "main-sha" } });
      if (url.endsWith("/git/refs")) return response({}, 201);
      if (url.endsWith("/merges")) return response({}, 201);
      if (url.endsWith("/pulls") && options?.method === "POST") return response({ html_url: "https://example.test/pull/9" }, 201);
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(createDeployRecoveryPullRequest("guchi-apps", "issue-deck", "token", [2, 1])).resolves.toEqual({ url: "https://example.test/pull/9" });

    const mergeBodies = githubFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/merges"))
      .map(([, , options]) => (options as { body: { head: string } }).body.head);
    expect(mergeBodies).toEqual(["merge-1", "merge-2"]);
  });

  it("競合時は途中ブランチを削除してPRを作らない", async () => {
    githubFetch.mockReset().mockImplementation(async (url: string) => {
      const candidates = candidatesResponses(url);
      if (candidates) return candidates;
      if (url.includes("state=open")) return response([]);
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: "main-sha" } });
      if (url.endsWith("/git/refs")) return response({}, 201);
      if (url.endsWith("/merges")) return response({ message: "conflict" }, 409);
      if (url.includes("/git/refs/heads/deploy-recovery/")) return response({}, 204);
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(createDeployRecoveryPullRequest("guchi-apps", "issue-deck", "token", [1])).rejects.toBeInstanceOf(DeployRecoveryConflictError);
    expect(githubFetch.mock.calls.some(([url, , options]) => String(url).includes("/git/refs/heads/deploy-recovery/") && (options as { method?: string }).method === "DELETE")).toBe(true);
  });
});
