import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.fn();
const withUserGithubToken = vi.fn();
const deleteIdeaDirectory = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

vi.mock("@/lib/github/with-user-github-token", () => ({
  get withUserGithubToken() {
    return withUserGithubToken;
  },
}));

vi.mock("@/lib/github/ideas-api", () => ({
  get deleteIdeaDirectory() {
    return deleteIdeaDirectory;
  },
  fetchIdeaDoc: vi.fn(),
  listIdeaDocs: vi.fn(),
  listIdeaSummaries: vi.fn(),
}));

import type { NextRequest } from "next/server";

import { DELETE } from "@/app/api/new-app/ideas/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("DELETE /api/new-app/ideas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    withUserGithubToken.mockResolvedValue({ value: true });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("通常の環境では構想の削除へ進む", async () => {
    const response = await DELETE(request({ path: "ideas/foo/README.md" }));

    expect(response.status).toBe(200);
    expect(withUserGithubToken).toHaveBeenCalled();
  });

  /**
   * #3718。worktreeの`.env.local`には`PREVIEW_MODE=true`が入っているため、ここが素通りすると
   * 開発サーバーの「削除」から本番の構想リポジトリへ削除コミットが入る。
   */
  it("プレビュー環境では403で封じる（開発サーバーから本番の構想リポジトリへ書かない）", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await DELETE(request({ path: "ideas/foo/README.md" }));

    expect(response.status).toBe(403);
    expect(withUserGithubToken).not.toHaveBeenCalled();
    expect(deleteIdeaDirectory).not.toHaveBeenCalled();
  });
});
