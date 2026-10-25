import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), repository: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/auth-user", () => ({ getCurrentUser: mocks.user, requireUserId: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: mocks.repository } } }));
vi.mock("@/lib/github/api-usage", () => ({ withGithubApiFeature: (_: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/github/issue-mapper", () => ({ mapComment: (comment: unknown) => comment }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: mocks.create }));
vi.mock("@/lib/github/with-user-github-token", () => ({ withUserGithubToken: async (_u: unknown, _c: unknown, fn: (token: string) => Promise<unknown>) => ({ value: await fn("token") }) }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
import { POST } from "./route";
// 質問機能（#5047で廃止）が送っていた`askQuestion`は、旧画面から届いても無視して通常のコメントとして保存する
const request = (extra: Record<string, unknown> = {}) => new NextRequest("http://localhost/api/issues/comments", {
  method: "POST", body: JSON.stringify({ owner: "guchi-apps", repo: "issue-deck", number: 4680, body: "コメント", ...extra }),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "u" });
  mocks.repository.mockResolvedValue({ fullName: "guchi-apps/issue-deck" });
  mocks.create.mockResolvedValue({ id: 1, body: "コメント" });
});
it("未認証では保存しない", async () => {
  mocks.user.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("アクセスできないリポジトリでは保存しない", async () => {
  mocks.repository.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(404);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("askQuestionが付いていても通常のコメントとして保存するだけ", async () => {
  const response = await POST(request({ askQuestion: true }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ comment: { id: 1, body: "コメント" } });
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
