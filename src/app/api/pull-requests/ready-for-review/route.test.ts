import { beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const markPullRequestReadyForReview = vi.fn();
const fetchPullRequest = vi.fn();

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
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
vi.mock("@/lib/github/actions-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/actions-api")>();
  return {
    ...actual,
    get markPullRequestReadyForReview() {
      return markPullRequestReadyForReview;
    },
  };
});
vi.mock("@/lib/github/pull-requests-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/pull-requests-api")>();
  return {
    ...actual,
    get fetchPullRequest() {
      return fetchPullRequest;
    },
  };
});

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/pull-requests/ready-for-review/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID = { owner: "guchi-apps", repo: "subpc", number: 123, headSha: "sha1" };
const OPEN_DRAFT = { state: "open", merged: false, draft: true, head: { sha: "sha1" }, node_id: "PR_node" };

describe("POST /api/pull-requests/ready-for-review", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchPullRequest.mockReset().mockResolvedValue(OPEN_DRAFT);
    markPullRequestReadyForReview.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("openかつdraftなら現在のNode IDでmutationを1回だけ実行する", async () => {
    const res = await POST(request(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyReady: false });
    expect(markPullRequestReadyForReview).toHaveBeenCalledTimes(1);
    expect(markPullRequestReadyForReview).toHaveBeenCalledWith("PR_node", "token");
  });

  it("既にレビュー可能ならmutationを撃たずalreadyReadyで返す（再送・連打）", async () => {
    fetchPullRequest.mockResolvedValue({ ...OPEN_DRAFT, draft: false });
    const res = await POST(request(VALID));
    expect(await res.json()).toEqual({ ok: true, alreadyReady: true });
    expect(markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  it("closed・mergedは409で、mutationを撃たない", async () => {
    fetchPullRequest.mockResolvedValue({ ...OPEN_DRAFT, state: "closed", merged: true });
    const res = await POST(request(VALID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("pull_request_not_open");
    expect(markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  it("headが変わっていれば409", async () => {
    const res = await POST(request({ ...VALID, headSha: "old" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("head_changed");
    expect(markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  it("権限不足は403のpermission_denied", async () => {
    markPullRequestReadyForReview.mockRejectedValue(new GithubApiError(403, "Resource not accessible by integration"));
    const res = await POST(request(VALID));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("permission_denied");
  });

  it("その他のAPI失敗は502で成功扱いにしない", async () => {
    markPullRequestReadyForReview.mockRejectedValue(new Error("boom"));
    const res = await POST(request(VALID));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("github_api_error");
  });

  it("対象外のリポジトリは404、入力不正は400、未認証は401", async () => {
    findFirst.mockResolvedValue(null);
    expect((await POST(request(VALID))).status).toBe(404);
    expect((await POST(request({ ...VALID, headSha: "" }))).status).toBe(400);
    requireUserId.mockResolvedValue(null);
    expect((await POST(request(VALID))).status).toBe(401);
  });
});
