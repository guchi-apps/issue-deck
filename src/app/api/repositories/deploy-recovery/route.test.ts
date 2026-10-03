import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const fetchLatestDeployWorkflowRun = vi.fn();
const fetchCandidates = vi.fn();
const createPullRequest = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));
vi.mock("@/lib/db", () => ({
  db: { repository: { get findFirst() { return findFirst; } } },
}));
vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));
vi.mock("@/lib/github/release-api", () => ({
  get fetchLatestDeployWorkflowRun() {
    return fetchLatestDeployWorkflowRun;
  },
}));
vi.mock("@/lib/github/deploy-recovery-api", () => ({
  get fetchDeployRecoveryCandidates() { return fetchCandidates; },
  get createDeployRecoveryPullRequest() { return createPullRequest; },
  DeployRecoveryConflictError: class DeployRecoveryConflictError extends Error {},
}));

import type { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/repositories/deploy-recovery/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function getRequest() {
  return new Request("http://localhost/api/repositories/deploy-recovery?owner=guchi-apps&repo=issue-deck") as NextRequest;
}

describe("/api/repositories/deploy-recovery（#3913）", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchLatestDeployWorkflowRun.mockReset().mockResolvedValue({ status: "completed", conclusion: "failure" });
    fetchCandidates.mockReset().mockResolvedValue({ candidates: [], truncated: false });
    createPullRequest.mockReset().mockResolvedValue({ url: "https://example.test/pull/10" });
  });

  it("候補を返す", async () => {
    fetchCandidates.mockResolvedValue({ candidates: [{ number: 9 }], truncated: false });
    const response = await GET(getRequest());
    await expect(response.json()).resolves.toEqual({ candidates: [{ number: 9 }], truncated: false });
  });

  it("失敗中なら選択したPRの復旧用PRを作る", async () => {
    const response = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumbers: [9] }));
    expect(response.status).toBe(200);
    expect(createPullRequest).toHaveBeenCalledWith("guchi-apps", "issue-deck", "token", [9]);
  });

  it("失敗中でなければ復旧PRを作らない", async () => {
    fetchLatestDeployWorkflowRun.mockResolvedValue({ status: "completed", conclusion: "success" });
    const response = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumbers: [9] }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "deploy_not_failed" });
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("PR未選択は拒否する", async () => {
    const response = await POST(request({ owner: "guchi-apps", repo: "issue-deck", pullRequestNumbers: [] }));
    expect(response.status).toBe(400);
  });
});
