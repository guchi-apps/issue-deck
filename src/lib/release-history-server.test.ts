import { afterEach, describe, expect, it, vi } from "vitest";

const cacheFindMany = vi.fn();
const cacheFindUnique = vi.fn();
const cacheUpdate = vi.fn();
const cacheUpsert = vi.fn();
const targetGroupBy = vi.fn();
const getInstallationToken = vi.fn();
const fetchReleasesBackTo = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    releaseHistoryCache: {
      findMany: (...args: unknown[]) => cacheFindMany(...args),
      findUnique: (...args: unknown[]) => cacheFindUnique(...args),
      update: (...args: unknown[]) => cacheUpdate(...args),
      upsert: (...args: unknown[]) => cacheUpsert(...args),
    },
    releaseCheckTarget: { groupBy: (...args: unknown[]) => targetGroupBy(...args) },
    $transaction: async (ops: unknown[]) => ops,
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: (...args: unknown[]) => getInstallationToken(...args) }));
vi.mock("@/lib/github/release-api", () => ({
  fetchReleasesBackTo: (...args: unknown[]) => fetchReleasesBackTo(...args),
}));
vi.mock("@/lib/github/unreleased-versions", () => ({
  appendUnreleasedVersions: async (_o: string, _r: string, _t: string, releases: unknown[]) => releases,
}));

import {
  isReleaseHistoryCacheFresh,
  loadReleaseHistoryFromCache,
  patchReleaseHistoryCacheBody,
  RELEASE_HISTORY_CACHE_TTL_MS,
} from "@/lib/release-history-server";

const repo = {
  id: "r1",
  fullName: "guchi-apps/a",
  ownerLogin: "guchi-apps",
  name: "a",
  installation: { installationId: 1 },
};
const NOW = Date.parse("2026-11-14T12:00:00Z");
const entry = { repoFullName: "guchi-apps/a", tagName: "v1.0.0", name: null, htmlUrl: "", publishedAt: null, body: "old" };

afterEach(() => {
  vi.clearAllMocks();
});

describe("isReleaseHistoryCacheFresh", () => {
  it("TTL内だけ新しいとみなす", () => {
    expect(isReleaseHistoryCacheFresh(new Date(NOW - RELEASE_HISTORY_CACHE_TTL_MS + 1000), NOW)).toBe(true);
    expect(isReleaseHistoryCacheFresh(new Date(NOW - RELEASE_HISTORY_CACHE_TTL_MS - 1000), NOW)).toBe(false);
  });
});

describe("loadReleaseHistoryFromCache", () => {
  it("鮮度内の写しはGitHubを呼ばずに返す", async () => {
    cacheFindMany.mockResolvedValue([{ repositoryId: "r1", entries: [entry], fetchedAt: new Date(NOW - 60_000) }]);
    targetGroupBy.mockResolvedValue([]);

    const result = await loadReleaseHistoryFromCache([repo], { refresh: false, nowMs: NOW });

    expect(fetchReleasesBackTo).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(result.loaded[0]).toMatchObject({ fullName: "guchi-apps/a", refreshed: false, entries: [entry] });
  });

  it("写しが無い・古い・refreshならGitHubから取り直し、全ユーザーの最小sinceMsで取る", async () => {
    const min = new Date("2026-09-01T00:00:00Z");
    cacheFindMany.mockResolvedValue([{ repositoryId: "r1", entries: [entry], fetchedAt: new Date(NOW - 60_000) }]);
    targetGroupBy.mockResolvedValue([{ repositoryId: "r1", _min: { createdAt: min } }]);
    getInstallationToken.mockResolvedValue("t");
    fetchReleasesBackTo.mockResolvedValue([{ ...entry, body: "new" }]);

    const result = await loadReleaseHistoryFromCache([repo], { refresh: true, nowMs: NOW });

    expect(fetchReleasesBackTo).toHaveBeenCalledWith("guchi-apps", "a", "t", min.getTime(), expect.any(Function));
    expect(result.loaded[0]).toMatchObject({ refreshed: true });
    expect(cacheUpsert).toHaveBeenCalled();
  });

  it("取り直しに失敗したリポジトリはfailedへ入れ、他は返す", async () => {
    cacheFindMany.mockResolvedValue([]);
    targetGroupBy.mockResolvedValue([]);
    getInstallationToken.mockResolvedValue("t");
    fetchReleasesBackTo.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await loadReleaseHistoryFromCache([repo], { refresh: false, nowMs: NOW });

    expect(result.loaded).toEqual([]);
    expect(result.failed.map((row) => row.fullName)).toEqual(["guchi-apps/a"]);
  });
});

describe("patchReleaseHistoryCacheBody", () => {
  it("該当タグの本文だけを差し替える", async () => {
    cacheFindUnique.mockResolvedValue({ entries: [entry, { ...entry, tagName: "v0.9.0" }] });

    await patchReleaseHistoryCacheBody("r1", "v1.0.0", "checked");

    const data = cacheUpdate.mock.calls[0][0].data.entries;
    expect(data[0].body).toBe("checked");
    expect(data[1].body).toBe("old");
  });

  it("写しが無ければ何もしない", async () => {
    cacheFindUnique.mockResolvedValue(null);
    await patchReleaseHistoryCacheBody("r1", "v1.0.0", "x");
    expect(cacheUpdate).not.toHaveBeenCalled();
  });
});
