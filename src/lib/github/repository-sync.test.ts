import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const deleteMany = vi.fn();
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
    },
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
});
