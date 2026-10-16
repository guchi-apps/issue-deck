import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), repository: vi.fn(), prepare: vi.fn(), create: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/auth-user", () => ({ getCurrentUser: mocks.user, requireUserId: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: mocks.repository } } }));
vi.mock("@/lib/github/api-usage", () => ({ withGithubApiFeature: (_: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/github/issue-mapper", () => ({ mapComment: (comment: unknown) => comment }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: mocks.create }));
vi.mock("@/lib/github/with-user-github-token", () => ({ withUserGithubToken: async (_u: unknown, _c: unknown, fn: (token: string) => Promise<unknown>) => ({ value: await fn("token") }) }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/dispatch/issue-question", () => ({ prepareIssueQuestion: mocks.prepare }));
import { POST } from "./route";
const request = (askQuestion = true) => new NextRequest("http://localhost/api/issues/comments", {
  method: "POST", body: JSON.stringify({ owner: "guchi-apps", repo: "issue-deck", number: 4680, body: "質問", askQuestion }),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "u" });
  mocks.repository.mockResolvedValue({ fullName: "guchi-apps/issue-deck" });
  mocks.prepare.mockResolvedValue({ send: mocks.send });
  mocks.create.mockResolvedValue({ id: 1, body: "質問" });
  mocks.send.mockResolvedValue(null);
});
it("未認証では保存も起動もしない", async () => {
  mocks.user.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("アクセスできないリポジトリでは起動を準備しない", async () => {
  mocks.repository.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(404);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("通常コメントはホストを起動しない", async () => {
  expect((await POST(request(false))).status).toBe(200);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("ホスト不在ならコメント保存前に理由を返す", async () => {
  mocks.prepare.mockResolvedValue({ error: "ホストがありません" });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect((await response.json()).message).toBe("ホストがありません");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("保存した後に起動し、起動拒否はコメントと警告を返す", async () => {
  mocks.send.mockResolvedValue("オフラインです");
  const response = await POST(request());
  expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
  expect(await response.json()).toEqual({ comment: { id: 1, body: "質問" }, warning: expect.stringContaining("起動に失敗") });
});
