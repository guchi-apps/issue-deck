import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const getCurrentUser = vi.fn();
const getInstallationToken = vi.fn();
const transferIssue = vi.fn();
const syncRepositoryIssues = vi.fn();
const upsertIssueAndGetDisplay = vi.fn();
const deleteTransferredSourceIssue = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/issues-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/issues-api")>();
  return {
    ...actual,
    get transferIssue() {
      return transferIssue;
    },
  };
});

vi.mock("@/lib/github/sync-issues", () => ({
  get syncRepositoryIssues() {
    return syncRepositoryIssues;
  },
  get upsertIssueAndGetDisplay() {
    return upsertIssueAndGetDisplay;
  },
  get deleteTransferredSourceIssue() {
    return deleteTransferredSourceIssue;
  },
}));

import { POST } from "@/app/api/issues/transfer/route";
import { IssueTransferPartialError } from "@/lib/github/issues-api";

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const SOURCE_REPO = {
  id: "repo-source",
  fullName: "owner/repo",
  ownerLogin: "owner",
  name: "repo",
  private: false,
  archived: false,
  installation: { installationId: 111 },
};

const DESTINATION_REPO = {
  id: "repo-destination",
  fullName: "new-owner/new-repo",
  ownerLogin: "new-owner",
  name: "new-repo",
  private: false,
  archived: false,
  installation: { installationId: 222 },
};

describe("POST /api/issues/transfer", () => {
  beforeEach(() => {
    getCurrentUser.mockReset().mockResolvedValue({ id: "user-1" });
    findFirst.mockReset().mockImplementation(async ({ where }: { where: { fullName: string } }) => {
      if (where.fullName === SOURCE_REPO.fullName) return SOURCE_REPO;
      if (where.fullName === DESTINATION_REPO.fullName) return DESTINATION_REPO;
      return null;
    });
    getInstallationToken.mockReset().mockResolvedValue("token");
    transferIssue.mockReset();
    syncRepositoryIssues.mockReset().mockResolvedValue(undefined);
    upsertIssueAndGetDisplay.mockReset();
    deleteTransferredSourceIssue.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("移動が成功した場合はDBを更新し、移動元の行だけを消す（再同期はしない）", async () => {
    transferIssue.mockResolvedValue({ id: 999, number: 5 });
    upsertIssueAndGetDisplay.mockResolvedValue({ id: "issue-1", number: 5 });

    const response = await POST(
      makeRequest({
        repositoryFullName: SOURCE_REPO.fullName,
        number: 1,
        newRepositoryFullName: DESTINATION_REPO.fullName,
      }),
    );

    expect(response.status).toBe(200);
    // 移動元の番号のまま残ると、GitHub上に存在しないIssueとして一覧に出続ける（#2406）
    expect(deleteTransferredSourceIssue).toHaveBeenCalledWith(SOURCE_REPO.id, 1, 999);
    expect(syncRepositoryIssues).not.toHaveBeenCalled();
  });

  it("再取得が最終的に失敗した場合は移動元リポジトリを再同期してクリーンアップする", async () => {
    transferIssue.mockRejectedValue(new IssueTransferPartialError(5, new Error("404")));

    const response = await POST(
      makeRequest({
        repositoryFullName: SOURCE_REPO.fullName,
        number: 1,
        newRepositoryFullName: DESTINATION_REPO.fullName,
      }),
    );

    expect(response.status).toBe(502);
    expect(syncRepositoryIssues).toHaveBeenCalledWith(SOURCE_REPO);
  });

  it("GraphQL自体が失敗した通常のエラーでは移動元のクリーンアップを行わない", async () => {
    const { GithubApiError } = await import("@/lib/github/issues-api");
    transferIssue.mockRejectedValue(new GithubApiError(403, "permission denied"));

    const response = await POST(
      makeRequest({
        repositoryFullName: SOURCE_REPO.fullName,
        number: 1,
        newRepositoryFullName: DESTINATION_REPO.fullName,
      }),
    );

    expect(response.status).toBe(502);
    expect(syncRepositoryIssues).not.toHaveBeenCalled();
  });
});
