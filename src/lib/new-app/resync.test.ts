import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installationFindMany = vi.fn();
const repositoryFindFirst = vi.fn();
const getInstallationToken = vi.fn();
const syncInstallationRepositories = vi.fn();
const syncRepositoryIssues = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    githubInstallation: {
      get findMany() {
        return installationFindMany;
      },
    },
    repository: {
      get findFirst() {
        return repositoryFindFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/repository-sync", () => ({
  get syncInstallationRepositories() {
    return syncInstallationRepositories;
  },
}));

vi.mock("@/lib/github/sync-issues", () => ({
  get syncRepositoryIssues() {
    return syncRepositoryIssues;
  },
}));

import { resyncNewRepository } from "@/lib/new-app/resync";

describe("resyncNewRepository", () => {
  beforeEach(() => {
    installationFindMany.mockReset().mockResolvedValue([{ id: "inst-1", installationId: 42 }]);
    repositoryFindFirst
      .mockReset()
      .mockResolvedValue({ id: "repo-1", fullName: "guchi-apps/kakei-report" });
    getInstallationToken.mockReset().mockResolvedValue("token-1");
    syncInstallationRepositories.mockReset().mockResolvedValue([]);
    syncRepositoryIssues.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("リポジトリを取り込んでから、作ったリポジトリのIssueだけを取り込む", async () => {
    await expect(resyncNewRepository("user-1", "guchi-apps", "kakei-report")).resolves.toEqual({
      ok: true,
    });
    expect(syncInstallationRepositories).toHaveBeenCalledWith(
      { id: "inst-1", installationId: 42 },
      "token-1",
    );
    expect(repositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fullName: "guchi-apps/kakei-report" } }),
    );
    expect(syncRepositoryIssues).toHaveBeenCalledTimes(1);
  });

  it("インストールが見つからなければ、その旨を返す", async () => {
    installationFindMany.mockResolvedValue([]);
    const result = await resyncNewRepository("user-1", "guchi-apps", "kakei-report");
    expect(result.ok).toBe(false);
    expect(syncRepositoryIssues).not.toHaveBeenCalled();
  });

  // 取り込んだのにDBへ現れない＝インストール対象に入っていない。画面へ理由を返す
  it("取り込んでもリポジトリが現れなければ、その旨を返す", async () => {
    repositoryFindFirst.mockResolvedValue(null);
    const result = await resyncNewRepository("user-1", "guchi-apps", "kakei-report");
    expect(result).toEqual({
      ok: false,
      message: "guchi-apps/kakei-report がGitHub Appのインストール対象に見つかりませんでした。",
    });
  });

  // ここで投げると、作り終えたIssueを返せないまま立ち上げ全体が失敗になる
  it("途中で失敗しても投げずに返す", async () => {
    syncInstallationRepositories.mockRejectedValue(new Error("boom"));
    await expect(resyncNewRepository("user-1", "guchi-apps", "kakei-report")).resolves.toEqual({
      ok: false,
      message: "boom",
    });
  });
});
