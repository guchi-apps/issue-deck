import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchOpenPullRequestsForBase = vi.fn();
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

  it("develop→mainのPRがオープン中のリポジトリのみマージ待ちとして返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string) => {
      if (repo === "repo-a") {
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
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/owner/repo-a/pull/12",
        pullRequestTitle: "release",
      },
    ]);
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

  it("CI用ダミーリポジトリはGitHub APIを呼ばず固定のダミーデータを返す", async () => {
    const ciDummyRepo = {
      fullName: "ci-dummy-org/sample-repo-1",
      ownerLogin: "ci-dummy-org",
      name: "sample-repo-1",
      githubRepositoryId: 900000001,
      installation: { installationId: 900000001 },
    };
    findMany.mockResolvedValue([ciDummyRepo]);

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([
      {
        repoFullName: "ci-dummy-org/sample-repo-1",
        pullRequestNumber: 9999,
        pullRequestUrl: "https://github.com/ci-dummy-org/sample-repo-1/pull/9999",
        pullRequestTitle: "v2.4.0をmainへ反映する",
      },
    ]);
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(releaseWorkflowExists).not.toHaveBeenCalled();
  });

  it("1リポジトリの取得に失敗しても他のリポジトリの結果は返す", async () => {
    fetchOpenPullRequestsForBase.mockImplementation(async (_owner: string, repo: string) => {
      if (repo === "repo-a") throw new Error("boom");
      return [
        {
          number: 3,
          html_url: "https://github.com/owner/repo-b/pull/3",
          title: "release",
          head: { ref: "develop" },
        },
      ];
    });

    const response = await GET();
    const json = await response.json();

    expect(json.pendingMerges).toEqual([
      {
        repoFullName: "owner/repo-b",
        pullRequestNumber: 3,
        pullRequestUrl: "https://github.com/owner/repo-b/pull/3",
        pullRequestTitle: "release",
      },
    ]);
  });
});
