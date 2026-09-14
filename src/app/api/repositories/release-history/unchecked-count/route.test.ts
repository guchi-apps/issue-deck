import { afterEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const releaseCheckTargetFindMany = vi.fn();
const releaseCheckFindMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchReleasesBackTo = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    releaseCheckTarget: {
      get findMany() {
        return releaseCheckTargetFindMany;
      },
    },
    releaseCheck: {
      get findMany() {
        return releaseCheckFindMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/release-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/release-api")>();
  return {
    ...actual,
    get fetchReleasesBackTo() {
      return fetchReleasesBackTo;
    },
  };
});

import { GET } from "@/app/api/repositories/release-history/unchecked-count/route";

function target(fullName: string, createdAt: Date) {
  return {
    createdAt,
    repository: {
      fullName,
      ownerLogin: fullName.split("/")[0],
      name: fullName.split("/")[1],
      installation: { installationId: 1 },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/repositories/release-history/unchecked-count", () => {
  it("未ログインなら401", async () => {
    requireUserId.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("確認を追う対象が0件ならGitHub APIを呼ばずに0を返す", async () => {
    requireUserId.mockResolvedValue("user1");
    releaseCheckTargetFindMany.mockResolvedValue([]);

    const res = await GET();
    const json = await res.json();

    expect(json).toEqual({ count: 0 });
    expect(fetchReleasesBackTo).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  // 計画レビューの指摘（#2951）。バッジを押して開く先（release-history-panel.tsx）のヘッダーは
  // 非表示リポジトリを除いた母集団から数えるため、揃えないと件数が食い違う
  it("母集団を非表示・アーカイブ済み・アクセス権の無いリポジトリを除いたものに揃える", async () => {
    requireUserId.mockResolvedValue("user1");
    releaseCheckTargetFindMany.mockResolvedValue([]);

    await GET();

    expect(releaseCheckTargetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user1",
          repository: {
            archived: false,
            installation: { userInstallations: { some: { userId: "user1" } } },
            hiddenBy: { none: { userId: "user1" } },
          },
        },
      }),
    );
  });

  it("対象リポジトリの未確認件数を返す", async () => {
    requireUserId.mockResolvedValue("user1");
    const since = new Date("2026-09-01T00:00:00Z");
    releaseCheckTargetFindMany.mockResolvedValue([target("guchi-apps/issue-deck", since)]);
    releaseCheckFindMany.mockResolvedValue([
      {
        tagName: "v1.0.0",
        checkedAt: new Date("2026-09-02T00:00:00Z"),
        repository: { fullName: "guchi-apps/issue-deck" },
      },
    ]);
    getInstallationToken.mockResolvedValue("token");
    fetchReleasesBackTo.mockResolvedValue([
      {
        repoFullName: "guchi-apps/issue-deck",
        tagName: "v1.0.0",
        name: null,
        htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v1.0.0",
        publishedAt: "2026-09-02T00:00:00Z",
        body: null,
      },
      {
        repoFullName: "guchi-apps/issue-deck",
        tagName: "v1.1.0",
        name: null,
        htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v1.1.0",
        publishedAt: "2026-09-05T00:00:00Z",
        body: null,
      },
    ]);

    const res = await GET();
    const json = await res.json();

    // v1.0.0は確認済み（checkRecords）、v1.1.0は未確認
    expect(json).toEqual({ count: 1 });
  });

  it("1リポジトリの取得失敗で他リポジトリの件数を巻き込まない", async () => {
    requireUserId.mockResolvedValue("user1");
    const since = new Date("2026-09-01T00:00:00Z");
    releaseCheckTargetFindMany.mockResolvedValue([
      target("guchi-apps/a", since),
      target("guchi-apps/b", since),
    ]);
    releaseCheckFindMany.mockResolvedValue([]);
    getInstallationToken.mockResolvedValue("token");
    fetchReleasesBackTo.mockImplementation(async (owner: string) => {
      if (owner === "guchi-apps") throw new Error("boom");
      return [];
    });
    fetchReleasesBackTo.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([
      {
        repoFullName: "guchi-apps/b",
        tagName: "v1.0.0",
        name: null,
        htmlUrl: "https://github.com/guchi-apps/b/releases/tag/v1.0.0",
        publishedAt: "2026-09-05T00:00:00Z",
        body: null,
      },
    ]);

    const res = await GET();
    const json = await res.json();

    expect(json).toEqual({ count: 1 });
  });
});
