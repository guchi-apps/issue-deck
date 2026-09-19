import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const repositoryFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchMergedPullRequestCount = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/merged-pr-count", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/merged-pr-count")>();
  return {
    ...actual,
    get fetchMergedPullRequestCount() {
      return fetchMergedPullRequestCount;
    },
  };
});

import { GET } from "@/app/api/code-review/merged-pr-counts/route";
import { clearMergedPullRequestCountCache } from "@/lib/github/merged-pr-count";

const SINCE = "guchi-apps/issue-deck|2026-09-01T00:00:00.000Z|";
const BETWEEN = "guchi-apps/issue-deck|2026-08-01T00:00:00.000Z|2026-09-01T00:00:00.000Z";
const OTHER = "someone/else|2026-09-01T00:00:00.000Z|";

function request(ranges: string[]) {
  const params = new URLSearchParams();
  for (const range of ranges) params.append("range", range);
  return new NextRequest(`http://localhost/api/code-review/merged-pr-counts?${params}`);
}

beforeEach(() => {
  requireUserId.mockResolvedValue("user-1");
  repositoryFindMany.mockResolvedValue([
    {
      fullName: "guchi-apps/issue-deck",
      defaultBranch: "develop",
      installation: { installationId: 1 },
    },
  ]);
  getInstallationToken.mockResolvedValue("token");
});

afterEach(() => {
  vi.clearAllMocks();
  clearMergedPullRequestCountCache();
});

describe("GET /api/code-review/merged-pr-counts", () => {
  it("未ログインなら401", async () => {
    requireUserId.mockResolvedValue(null);
    const res = await GET(request([SINCE]));
    expect(res.status).toBe(401);
  });

  it("期間ごとの件数を返し、接続していないリポジトリと読めない期間は捨てる", async () => {
    fetchMergedPullRequestCount.mockResolvedValueOnce(12).mockResolvedValueOnce(40);
    const res = await GET(request([SINCE, BETWEEN, OTHER, "not-a-range"]));
    const data = await res.json();
    expect(data.counts).toEqual([
      { key: SINCE, count: 12 },
      { key: BETWEEN, count: 40 },
    ]);
    expect(fetchMergedPullRequestCount).toHaveBeenCalledTimes(2);
    expect(fetchMergedPullRequestCount.mock.calls[0][1]).toBe("develop");
  });

  it("2回目はキャッシュから返し、GitHubへ行かない", async () => {
    fetchMergedPullRequestCount.mockResolvedValue(3);
    await GET(request([BETWEEN]));
    const res = await GET(request([BETWEEN]));
    expect((await res.json()).counts).toEqual([{ key: BETWEEN, count: 3 }]);
    expect(fetchMergedPullRequestCount).toHaveBeenCalledTimes(1);
  });

  it("取れなかった期間は結果に入れない", async () => {
    fetchMergedPullRequestCount.mockRejectedValueOnce(new Error("rate limited"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request([SINCE]));
    expect((await res.json()).counts).toEqual([]);
  });
});
