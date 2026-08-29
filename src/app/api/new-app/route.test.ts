import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
const userUpdate = vi.fn();
const userFindUnique = vi.fn();
const repositoryExists = vi.fn();
const createOrgRepository = vi.fn();
const setupDevelopBranch = vi.fn();
const cloneRepositoryLabels = vi.fn();
const fetchVpsUsage = vi.fn();
const planLocalPortBand = vi.fn();
const openLocalPortBandPullRequest = vi.fn();
const findExistingVpsLaunchIssue = vi.fn();
const createIssue = vi.fn();
const createComment = vi.fn();
const addSubIssue = vi.fn();
const fetchLatestWorkflowTag = vi.fn();
const resolveScaffoldCopies = vi.fn();
const commitScaffoldFiles = vi.fn();
const resolveNewAppInstallationScope = vi.fn();
const resyncNewRepository = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

vi.mock("@/lib/preview-mode", () => ({
  previewModeGuard: () => null,
}));

vi.mock("@/lib/github/api-usage", () => ({
  withGithubApiFeature: <T>(_feature: string, fn: () => T) => fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      get update() {
        return userUpdate;
      },
      get findUnique() {
        return userFindUnique;
      },
    },
  },
}));

vi.mock("@/lib/crypto/secret-cipher", () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (cipher: string) => cipher.replace(/^enc:/, ""),
}));

vi.mock("@/lib/github/refresh-user-token", () => ({
  refreshGithubUserToken: vi.fn(),
}));

vi.mock("@/lib/github/repositories-api", () => ({
  get repositoryExists() {
    return repositoryExists;
  },
  get createOrgRepository() {
    return createOrgRepository;
  },
  get setupDevelopBranch() {
    return setupDevelopBranch;
  },
  get cloneRepositoryLabels() {
    return cloneRepositoryLabels;
  },
}));

vi.mock("@/lib/github/vps-inventory-api", () => ({
  get fetchVpsUsage() {
    return fetchVpsUsage;
  },
}));

vi.mock("@/lib/github/local-port-band-api", () => ({
  get planLocalPortBand() {
    return planLocalPortBand;
  },
  get openLocalPortBandPullRequest() {
    return openLocalPortBandPullRequest;
  },
}));

vi.mock("@/lib/github/new-app-existing-issue", () => ({
  get findExistingVpsLaunchIssue() {
    return findExistingVpsLaunchIssue;
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createIssue() {
    return createIssue;
  },
  get createComment() {
    return createComment;
  },
  get addSubIssue() {
    return addSubIssue;
  },
}));

vi.mock("@/lib/github/workflow-tags", () => ({
  get fetchLatestWorkflowTag() {
    return fetchLatestWorkflowTag;
  },
}));

vi.mock("@/lib/github/scaffold-api", () => ({
  get resolveScaffoldCopies() {
    return resolveScaffoldCopies;
  },
  get commitScaffoldFiles() {
    return commitScaffoldFiles;
  },
}));

vi.mock("@/lib/new-app/installation-scope", () => ({
  get resolveNewAppInstallationScope() {
    return resolveNewAppInstallationScope;
  },
}));

vi.mock("@/lib/new-app/resync", () => ({
  get resyncNewRepository() {
    return resyncNewRepository;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/new-app/route";
import { GithubApiError } from "@/lib/github/github-api-error";
import { refreshGithubUserToken } from "@/lib/github/refresh-user-token";
import { LAUNCH_UNAUTHORIZED_MESSAGE } from "@/lib/new-app/launch-failure";
import { emptyNewAppSpec } from "@/lib/new-app/spec";

const mockedRefresh = vi.mocked(refreshGithubUserToken);

/** route側は`request.json()`しか使わないため、そこだけを持つ最小のリクエストを渡す */
function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const SPEC = {
  ...emptyNewAppSpec(),
  displayName: "家計レポート",
  repositoryName: "kakei-report",
  summary: "家計の月次推移をZaimのデータから作る",
  subdomain: "kakei-report",
  port: 3112,
  databaseName: "app_kakei_report",
  auth: "supabase-google" as const,
};

describe("POST /api/new-app", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    getCurrentUser.mockReset().mockResolvedValue({
      id: "user-1",
      githubAccessToken: "enc:old-access",
      githubRefreshToken: "enc:old-refresh",
    });
    userUpdate.mockReset().mockResolvedValue(undefined);
    userFindUnique.mockReset().mockResolvedValue(null);
    mockedRefresh.mockReset().mockResolvedValue({ accessToken: "new-access" });

    repositoryExists.mockReset().mockResolvedValue(false);
    fetchVpsUsage.mockReset().mockResolvedValue(null);
    planLocalPortBand
      .mockReset()
      .mockResolvedValue({ base: 25000, alreadyListed: true, conf: { content: "", sha: "" } });
    openLocalPortBandPullRequest.mockReset();
    createOrgRepository
      .mockReset()
      .mockResolvedValue({ htmlUrl: "https://github.com/guchi-apps/kakei-report", defaultBranch: "main" });
    setupDevelopBranch.mockReset().mockResolvedValue(undefined);
    cloneRepositoryLabels.mockReset().mockResolvedValue(undefined);
    fetchLatestWorkflowTag.mockReset().mockResolvedValue("workflows/v1");
    resolveScaffoldCopies.mockReset().mockResolvedValue({ files: [], problems: [] });
    commitScaffoldFiles.mockReset().mockResolvedValue(undefined);
    resolveNewAppInstallationScope.mockReset().mockResolvedValue({ needsRepositoryAdd: false });
    findExistingVpsLaunchIssue.mockReset().mockResolvedValue(null);
    addSubIssue.mockReset().mockResolvedValue(undefined);
    resyncNewRepository.mockReset().mockResolvedValue({ ok: true });

    let number = 0;
    createIssue.mockReset().mockImplementation(async () => {
      number += 1;
      return { id: number * 100, number, html_url: `https://github.com/x/y/issues/${number}` };
    });
  });

  it("すべて成功すれば作られたものを返す", async () => {
    const res = await POST(request({ spec: SPEC }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created[0]).toMatchObject({ kind: "repository", reference: "guchi-apps/kakei-report" });
    expect(createOrgRepository).toHaveBeenCalledTimes(1);
  });

  // #2442: 立ち上げは非冪等なので、途中の401で丸ごと再実行させてはいけない
  it("リポジトリを作った後に401が出ても再実行せず、作られたものと一緒に返す", async () => {
    createIssue.mockRejectedValueOnce(new GithubApiError(401, "unauthorized"));

    const res = await POST(request({ spec: SPEC }));

    // 再実行されると`repositoryExists`が自分で作ったリポジトリを見つけ、原因と食い違う
    // `repository_taken`で終わってしまう
    expect(createOrgRepository).toHaveBeenCalledTimes(1);
    expect(repositoryExists).toHaveBeenCalledTimes(1);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("launch_failed");
    expect(body.step).toBe("repository");
    expect(body.message).toBe(LAUNCH_UNAUTHORIZED_MESSAGE);
    expect(body.created).toHaveLength(1);
    expect(body.created[0]).toMatchObject({ kind: "repository" });
  });

  it("まだ何も作っていないうちの401は、トークンを延長して最初からやり直す", async () => {
    repositoryExists.mockRejectedValueOnce(new GithubApiError(401, "unauthorized"));

    const res = await POST(request({ spec: SPEC }));

    expect(mockedRefresh).toHaveBeenCalledWith("old-refresh");
    expect(repositoryExists).toHaveBeenCalledTimes(2);
    expect(createOrgRepository).toHaveBeenCalledTimes(1);
    expect(createOrgRepository).toHaveBeenCalledWith("guchi-apps", "new-access", expect.anything());
    expect(res.status).toBe(200);
  });
});
