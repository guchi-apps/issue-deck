import { beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const updatePullRequest = vi.fn();

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
    get updatePullRequest() {
      return updatePullRequest;
    },
  };
});

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/pull-requests/update/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID = { owner: "guchi-apps", repo: "issue-deck", number: 3170, title: " 新しいタイトル ", body: "本文" };

describe("POST /api/pull-requests/update", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({
      fullName: "guchi-apps/issue-deck",
      installation: { installationId: 1 },
    });
    getInstallationToken.mockReset().mockResolvedValue("token");
    updatePullRequest.mockReset().mockResolvedValue(undefined);
  });

  it("タイトルの前後の空白を落として、タイトルと本文をまとめて書き換える", async () => {
    const res = await POST(request(VALID));

    expect(res.status).toBe(200);
    expect(updatePullRequest).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      3170,
      { title: "新しいタイトル", body: "本文" },
      "token",
    );
  });

  it("本文は空でも受け付ける（本文を消したいことがある）", async () => {
    const res = await POST(request({ ...VALID, body: "" }));

    expect(res.status).toBe(200);
    expect(updatePullRequest.mock.calls[0][3]).toEqual({ title: "新しいタイトル", body: "" });
  });

  it.each([
    ["タイトルが空白だけ", { ...VALID, title: "  " }],
    ["本文が無い（送り忘れと空を区別できない）", { ...VALID, body: undefined }],
    ["番号が数値でない", { ...VALID, number: "3170" }],
  ])("%sなら400で、GitHubを呼ばない", async (_label, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("未ログインなら401", async () => {
    requireUserId.mockResolvedValue(null);

    const res = await POST(request(VALID));

    expect(res.status).toBe(401);
  });

  it("自分のインストールに無いリポジトリなら404で、GitHubを呼ばない", async () => {
    findFirst.mockResolvedValue(null);

    const res = await POST(request(VALID));

    expect(res.status).toBe(404);
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("GitHubが失敗したら502でメッセージを返す", async () => {
    updatePullRequest.mockRejectedValue(new GithubApiError(422, "Validation Failed"));

    const res = await POST(request(VALID));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "github_api_error", message: "Validation Failed" });
  });
});
