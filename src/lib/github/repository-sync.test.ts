import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const deleteMany = vi.fn();
const findMany = vi.fn();
const recordRepositoryRename = vi.fn();
const fetchClaudeWorkflowExists = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get upsert() {
        return upsert;
      },
      get deleteMany() {
        return deleteMany;
      },
      get findMany() {
        return findMany;
      },
    },
  },
}));

vi.mock("@/lib/repository-alias", () => ({
  get recordRepositoryRename() {
    return recordRepositoryRename;
  },
}));

vi.mock("@/lib/github/workflow-support", () => ({
  get fetchClaudeWorkflowExists() {
    return fetchClaudeWorkflowExists;
  },
}));

import { syncInstallationRepositories } from "@/lib/github/repository-sync";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("syncInstallationRepositories", () => {
  beforeEach(() => {
    upsert.mockReset().mockImplementation(async ({ create }) => ({ id: "repo-1", ...create }));
    deleteMany.mockReset().mockResolvedValue(undefined);
    findMany.mockReset().mockResolvedValue([]);
    recordRepositoryRename.mockReset().mockResolvedValue(undefined);
    fetchClaudeWorkflowExists.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GitHub上のリポジトリごとにclaude-issue-dispatch.ymlの有無をhasClaudeWorkflowとして保存する", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        repositories: [
          {
            id: 1,
            name: "repo-a",
            full_name: "owner/repo-a",
            private: false,
            html_url: "https://github.com/owner/repo-a",
            archived: false,
            default_branch: "main",
            owner: { login: "owner" },
          },
          {
            id: 2,
            name: "repo-b",
            full_name: "owner/repo-b",
            private: true,
            html_url: "https://github.com/owner/repo-b",
            archived: false,
            default_branch: "main",
            owner: { login: "owner" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fetchClaudeWorkflowExists.mockImplementation(async (_owner: string, repo: string) => repo === "repo-a");

    const result = await syncInstallationRepositories({ id: "installation-1" }, "token");

    expect(result).toHaveLength(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({ fullName: "owner/repo-a", hasClaudeWorkflow: true }),
        update: expect.objectContaining({ hasClaudeWorkflow: true }),
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({ fullName: "owner/repo-b", hasClaudeWorkflow: false }),
        update: expect.objectContaining({ hasClaudeWorkflow: false }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: { installationId: "installation-1", githubRepositoryId: { notIn: [1, 2] } },
    });
  });

  it("workflow存在チェックが失敗した場合はhasClaudeWorkflow=falseとして扱う", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        repositories: [
          {
            id: 1,
            name: "repo-a",
            full_name: "owner/repo-a",
            private: false,
            html_url: "https://github.com/owner/repo-a",
            archived: false,
            default_branch: "main",
            owner: { login: "owner" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fetchClaudeWorkflowExists.mockRejectedValue(new Error("boom"));

    await syncInstallationRepositories({ id: "installation-1" }, "token");

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ hasClaudeWorkflow: false }) }),
    );
  });

  it("DBの名前と異なる名前で返ってきたリポジトリは、改名として記録する（#3613）", async () => {
    const repo = (id: number, name: string) => ({
      id,
      name,
      full_name: `owner/${name}`,
      private: false,
      html_url: `https://github.com/owner/${name}`,
      archived: false,
      default_branch: "main",
      owner: { login: "owner" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { repositories: [repo(1, "kurashio"), repo(2, "same")] })));
    fetchClaudeWorkflowExists.mockResolvedValue(false);
    findMany.mockResolvedValue([
      { githubRepositoryId: 1, name: "myroom" },
      { githubRepositoryId: 2, name: "same" },
    ]);

    await syncInstallationRepositories({ id: "installation-1" }, "token");

    expect(recordRepositoryRename).toHaveBeenCalledTimes(1);
    expect(recordRepositoryRename).toHaveBeenCalledWith({
      githubRepositoryId: 1,
      oldName: "myroom",
      newName: "kurashio",
    });
  });
});
