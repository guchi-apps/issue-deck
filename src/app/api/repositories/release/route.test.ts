import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const dispatchReleaseWorkflow = vi.fn();
const releaseWorkflowExists = vi.fn();

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
    get dispatchReleaseWorkflow() {
      return dispatchReleaseWorkflow;
    },
  };
});

vi.mock("@/lib/github/release-workflow-cache", () => ({
  get releaseWorkflowExists() {
    return releaseWorkflowExists;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/route";

/** route側は`request.json()`しか使わないため、そこだけを持つ最小のリクエストを渡す */
function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/repositories/release", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    dispatchReleaseWorkflow.mockReset().mockResolvedValue(undefined);
    releaseWorkflowExists.mockReset().mockResolvedValue(true);
  });

  it("リリース用workflowがあれば起動する", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck" }));

    expect(res.status).toBe(200);
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith("guchi-apps", "issue-deck", "token");
  });

  it("リリース用workflowが無ければ起動せず400を返す（#1538）", async () => {
    releaseWorkflowExists.mockResolvedValue(false);

    const res = await POST(request({ owner: "guchi-apps", repo: "clip-hive" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "release_workflow_missing" });
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });
});
