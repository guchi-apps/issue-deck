import { beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const fetchPullRequest = vi.fn();
const fetchWorkflowRunsForHead = vi.fn();
const rerunWorkflowRun = vi.fn();

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));
vi.mock("@/lib/github/actions-api", () => ({
  get fetchWorkflowRunsForHead() {
    return fetchWorkflowRunsForHead;
  },
  get rerunWorkflowRun() {
    return rerunWorkflowRun;
  },
}));
vi.mock("@/lib/github/pull-requests-api", () => ({
  get fetchPullRequest() {
    return fetchPullRequest;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/pull-requests/ci-rerun/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID = { owner: "o", repo: "r", number: 1, headSha: "sha1", scope: "all" };
const run = (id: number, name: string) => ({
  id,
  name,
  path: `.github/workflows/${name}.yml`,
  status: "completed",
  conclusion: "failure",
  head_sha: "sha1",
  event: "pull_request",
  html_url: null,
});

describe("POST /api/pull-requests/ci-rerun", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("u");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("t");
    fetchPullRequest.mockReset().mockResolvedValue({ state: "open", merged: false, head: { sha: "sha1" } });
    fetchWorkflowRunsForHead.mockReset().mockResolvedValue([run(1, "ci"), run(2, "lint")]);
    rerunWorkflowRun.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("全runを再実行する", async () => {
    const res = await POST(request(VALID));
    expect(await res.json()).toMatchObject({ ok: true, rerunCount: 2, failedRuns: [] });
  });

  it("一部だけ失敗したときは部分成功として失敗したrunを返す", async () => {
    rerunWorkflowRun.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new GithubApiError(500, "x"));
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, rerunCount: 1, failedRuns: [{ id: 2, name: "lint" }] });
  });

  it("全件失敗は502、先頭の403は権限不足", async () => {
    rerunWorkflowRun.mockRejectedValue(new GithubApiError(500, "x"));
    expect((await POST(request(VALID))).status).toBe(502);
    rerunWorkflowRun.mockReset().mockRejectedValue(new GithubApiError(403, "x"));
    expect((await POST(request(VALID))).status).toBe(403);
  });

  it("head変更は409で再実行しない", async () => {
    const res = await POST(request({ ...VALID, headSha: "old" }));
    expect(res.status).toBe(409);
    expect(rerunWorkflowRun).not.toHaveBeenCalled();
  });
});
