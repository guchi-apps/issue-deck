import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchOpenPullRequestsForBase = vi.fn();
const fetchRefCiState = vi.fn();
const releaseWorkflowExists = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return findMany;
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
    get fetchOpenPullRequestsForBase() {
      return fetchOpenPullRequestsForBase;
    },
    get fetchRefCiState() {
      return fetchRefCiState;
    },
  };
});

vi.mock("@/lib/github/release-workflow-cache", () => ({
  get releaseWorkflowExists() {
    return releaseWorkflowExists;
  },
}));

import { GET } from "@/app/api/repositories/release-pending-merges/route";

const REPO_A = {
  fullName: "owner/repo-a",
  ownerLogin: "owner",
  name: "repo-a",
  installation: { installationId: 111 },
};
const REPO_B = {
  fullName: "owner/repo-b",
  ownerLogin: "owner",
  name: "repo-b",
  installation: { installationId: 111 },
};

describe("GET /api/repositories/release-pending-merges", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findMany.mockReset().mockResolvedValue([REPO_A, REPO_B]);
    getInstallationToken.mockReset().mockResolvedValue("token");
    releaseWorkflowExists.mockReset().mockResolvedValue(true);
    fetchOpenPullRequestsForBase.mockReset().mockResolvedValue([]);
    fetchRefCiState.mockReset().mockResolvedValue("success");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未ログインの場合は401を返す", async () => {
    requireUserId.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("develop→mainのPRがオープン中のリポジトリはmainへのマージ待ちとして返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string, base: string) => {
      if (base === "main" && repo === "repo-a") {
        return [
          {
            number: 12,
            html_url: "https://github.com/owner/repo-a/pull/12",
            title: "release",
            head: { ref: "develop" },
          },
        ];
      }
      return [];
    });

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([
      {
        repoFullName: "owner/repo-a",
        mergeTarget: "main",
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/owner/repo-a/pull/12",
        pullRequestTitle: "release",
      },
    ]);
    expect(fetchRefCiState).not.toHaveBeenCalled();
  });

  it("バンプPRがCI通過後も残っているリポジトリはdevelopへのマージ待ちとして返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string, base: string) => {
      if (base === "develop" && repo === "repo-a") {
        return [
          {
            number: 34,
            html_url: "https://github.com/owner/repo-a/pull/34",
            title: "release/v1.2.3",
            head: { ref: "release/v1.2.3" },
          },
        ];
      }
      return [];
    });
    fetchRefCiState.mockResolvedValue("success");

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([
      {
        repoFullName: "owner/repo-a",
        mergeTarget: "develop",
        pullRequestNumber: 34,
        pullRequestUrl: "https://github.com/owner/repo-a/pull/34",
        pullRequestTitle: "release/v1.2.3",
      },
    ]);
  });

  it("バンプPRのCIがpending中はマージ待ちに含めない", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string, base: string) => {
      if (base === "develop" && repo === "repo-a") {
        return [
          {
            number: 34,
            html_url: "https://github.com/owner/repo-a/pull/34",
            title: "release/v1.2.3",
            head: { ref: "release/v1.2.3" },
          },
        ];
      }
      return [];
    });
    fetchRefCiState.mockResolvedValue("pending");

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([]);
  });

  it("リリースworkflowが存在しないリポジトリは対象外にする", async () => {
    releaseWorkflowExists.mockResolvedValue(false);

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([]);
    expect(fetchOpenPullRequestsForBase).not.toHaveBeenCalled();
  });

  it("同一installationのトークン取得は1回に抑える", async () => {
    await GET();

    expect(getInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("1リポジトリの取得に失敗しても他のリポジトリの結果は返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string, base: string) => {
      if (repo === "repo-a") throw new Error("boom");
      if (base === "main" && repo === "repo-b") {
        return [
          {
            number: 3,
            html_url: "https://github.com/owner/repo-b/pull/3",
            title: "release",
            head: { ref: "develop" },
          },
        ];
      }
      return [];
    });

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([
      {
        repoFullName: "owner/repo-b",
        mergeTarget: "main",
        pullRequestNumber: 3,
        pullRequestUrl: "https://github.com/owner/repo-b/pull/3",
        pullRequestTitle: "release",
      },
    ]);
  });
});
