import { beforeEach, describe, expect, it, vi } from "vitest";

const githubFetch = vi.fn();
const fetchTagRefs = vi.fn();

vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  githubFetch: (...args: unknown[]) => githubFetch(...args),
}));
vi.mock("@/lib/github/release-api", () => ({
  fetchDeployRunForSha: async () => null,
  fetchReleaseNotesFile: async () => {
    throw new Error("none");
  },
  fetchTagRefs: (...args: unknown[]) => fetchTagRefs(...args),
}));

import { appendUnreleasedVersions, clearUnreleasedVersionsMemo, UNRELEASED_CONCURRENCY } from "./unreleased-versions";

const TAG_COUNT = 30;

describe("appendUnreleasedVersions の同時実行数（#4255）", () => {
  beforeEach(() => {
    clearUnreleasedVersionsMemo();
    githubFetch.mockReset();
    fetchTagRefs.mockReset();
    fetchTagRefs.mockResolvedValue(
      Array.from({ length: TAG_COUNT }, (_, i) => ({ ref: `refs/tags/v1.0.${i}`, object: { sha: `sha${i}` } })),
    );
  });

  it("多数の未公開タグでも、同時に出すタグ補完の組数が上限を超えない", async () => {
    let inFlight = 0;
    let peak = 0;
    githubFetch.mockImplementation(async (url: string) => {
      if (url.includes("/commits/")) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      }
      return { ok: true, json: async () => ({ commit: { committer: { date: "2026-01-01T00:00:00Z" } }, body: "- a" }) };
    });
    await appendUnreleasedVersions("o", "r", "t", [
      { repoFullName: "o/r", tagName: "v0.9.0", name: "v0.9.0", htmlUrl: "", publishedAt: "2025-01-01T00:00:00Z", body: "" } as never,
    ]);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(UNRELEASED_CONCURRENCY);
  });

  it("一部のタグで取得が投げても、元の履歴と取れたタグは維持する", async () => {
    githubFetch.mockImplementation(async (url: string) => {
      if (url.includes("/commits/v1.0.3")) throw new Error("network");
      return { ok: true, json: async () => ({ commit: { committer: { date: "2026-01-01T00:00:00Z" } }, body: "- a" }) };
    });
    const releases = [
      { repoFullName: "o/r", tagName: "v0.9.0", name: "v0.9.0", htmlUrl: "", publishedAt: "2025-01-01T00:00:00Z", body: "" } as never,
    ];
    const result = await appendUnreleasedVersions("o", "r", "t", releases);
    expect(result.length).toBeGreaterThan(1);
    expect(result.some((r) => r.tagName === "v1.0.3")).toBe(false);
  });
});
