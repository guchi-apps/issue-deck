import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const dispatchDeployWorkflow = vi.fn();
const deployWorkflowExists = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
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

vi.mock("@/lib/github/release-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/release-api")>();
  return {
    ...actual,
    get dispatchDeployWorkflow() {
      return dispatchDeployWorkflow;
    },
  };
});

vi.mock("@/lib/github/deploy-workflow-cache", () => ({
  get deployWorkflowExists() {
    return deployWorkflowExists;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/deploy/route";
import { GithubApiError } from "@/lib/github/github-api-error";

/** route側は`request.json()`しか使わないため、そこだけを持つ最小のリクエストを渡す */
function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/repositories/deploy（#2020）", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    dispatchDeployWorkflow.mockReset().mockResolvedValue(undefined);
    deployWorkflowExists.mockReset().mockResolvedValue(true);
  });

  it("deploy.ymlがあれば起動する", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck" }));

    expect(res.status).toBe(200);
    expect(dispatchDeployWorkflow).toHaveBeenCalledWith("guchi-apps", "issue-deck", "token");
  });

  it("deploy.ymlが無ければ起動せず deploy_workflow_missing を返す", async () => {
    deployWorkflowExists.mockResolvedValue(false);

    const res = await POST(request({ owner: "guchi-apps", repo: "docs" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "deploy_workflow_missing" });
    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
  });

  it("workflow_dispatchを持たないリポジトリは deploy_dispatch_unsupported を返す", async () => {
    dispatchDeployWorkflow.mockRejectedValue(
      new GithubApiError(422, "GitHub API request failed: 422 Workflow does not have 'workflow_dispatch' trigger"),
    );

    const res = await POST(request({ owner: "guchi-apps", repo: "portfolio" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "deploy_dispatch_unsupported" });
  });

  it("422以外の失敗は通常のエラーとして扱う", async () => {
    dispatchDeployWorkflow.mockRejectedValue(new GithubApiError(500, "boom"));

    const res = await POST(request({ owner: "guchi-apps", repo: "aide" }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "github_api_error" });
  });

  it("owner・repoが無ければ400を返す", async () => {
    const res = await POST(request({ owner: "guchi-apps" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_request" });
    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
  });

  it("見えないリポジトリは404を返す", async () => {
    findFirst.mockResolvedValue(null);

    const res = await POST(request({ owner: "other", repo: "secret" }));

    expect(res.status).toBe(404);
    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
  });
});
