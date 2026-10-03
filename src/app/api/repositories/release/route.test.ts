import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const dispatchReleaseWorkflow = vi.fn();
const fetchLatestDeployWorkflowRun = vi.fn();
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
    get fetchLatestDeployWorkflowRun() {
      return fetchLatestDeployWorkflowRun;
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
import { GithubApiError } from "@/lib/github/github-api-error";

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
    fetchLatestDeployWorkflowRun.mockReset().mockResolvedValue(null);
    releaseWorkflowExists.mockReset().mockResolvedValue(true);
  });

  it("リリース用workflowがあれば起動する", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck" }));

    expect(res.status).toBe(200);
    // 上げ幅を指定しない場合はinputを送らない（自動判定。#1548）
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "token",
      undefined,
      false,
    );
  });

  it("上げ幅を指定するとdispatchへ渡す（#1548）", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", bumpKind: "minor" }));

    expect(res.status).toBe(200);
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "token",
      "minor",
      false,
    );
  });

  it("本番デプロイが失敗している間は起動せず409を返す（#3897）", async () => {
    fetchLatestDeployWorkflowRun.mockResolvedValue({ status: "completed", conclusion: "failure" });

    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck" }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "deploy_failed" });
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it("本番デプロイ失敗中でも明示的な手動上書きなら起動する（#3912）", async () => {
    fetchLatestDeployWorkflowRun.mockResolvedValue({ status: "completed", conclusion: "timed_out" });

    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", allowFailedDeploy: true }));

    expect(res.status).toBe(200);
    expect(dispatchReleaseWorkflow).toHaveBeenCalledWith("guchi-apps", "issue-deck", "token", undefined, true);
  });

  it("上書きはbooleanだけを受け付ける", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", allowFailedDeploy: "true" }));

    expect(res.status).toBe(400);
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it("上書きinputに未対応のworkflowでは専用エラーを返す", async () => {
    dispatchReleaseWorkflow.mockRejectedValue(new GithubApiError(422, "Unexpected inputs provided"));

    const res = await POST(request({ owner: "guchi-apps", repo: "dayspan", allowFailedDeploy: true }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "failed_deploy_override_unsupported" });
  });

  it("上げ幅が不正な値なら起動せず400を返す（#1548）", async () => {
    const res = await POST(request({ owner: "guchi-apps", repo: "issue-deck", bumpKind: "huge" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_request" });
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });

  it("workflowが上げ幅のinputを持たない場合は bump_kind_unsupported を返す（#1548）", async () => {
    dispatchReleaseWorkflow.mockRejectedValue(
      new GithubApiError(422, "GitHub API request failed: 422 Unexpected inputs provided"),
    );

    const res = await POST(request({ owner: "guchi-apps", repo: "dayspan", bumpKind: "major" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bump_kind_unsupported" });
  });

  it("上げ幅を指定していなければ422でも通常のエラーとして扱う（#1548）", async () => {
    dispatchReleaseWorkflow.mockRejectedValue(new GithubApiError(422, "unprocessable"));

    const res = await POST(request({ owner: "guchi-apps", repo: "dayspan" }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "github_api_error" });
  });

  it("リリース用workflowが無ければ起動せず400を返す（#1538）", async () => {
    releaseWorkflowExists.mockResolvedValue(false);

    const res = await POST(request({ owner: "guchi-apps", repo: "clip-hive" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "release_workflow_missing" });
    expect(dispatchReleaseWorkflow).not.toHaveBeenCalled();
  });
});
