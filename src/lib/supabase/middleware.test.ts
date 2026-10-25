import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), user: { id: "test" } as { id: string } | null }));
vi.mock("@/lib/access/client", () => ({ isUserAllowed: mocks.allowed }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: {
  getUser: async () => ({ data: { user: mocks.user } }),
} }) }));
vi.mock("@/lib/ci-auth-bypass", () => ({ CI_BYPASS_COOKIE_NAME: "test-ci", isCiBypassRequest: () => false }));
import { updateSession } from "./middleware";
beforeEach(() => {
  mocks.user = { id: "test" };
  mocks.allowed.mockResolvedValue(true);
});
describe("コールバック失敗後の再ログイン", () => {
  it("セッションが残っていてもエラー画面を表示する", async () => {
    const result = await updateSession(new NextRequest("https://example.com/login?error=callback_failed"));
    expect(result.headers.get("location")).toBeNull();
  });
  it("通常のログイン画面では既存のリダイレクトを維持する", async () => {
    const result = await updateSession(new NextRequest("https://example.com/login"));
    expect(result.headers.get("location")).toContain("/dashboard");
  });
  it("エラーパラメータを付けても保護ページの認可を迂回しない", async () => {
    mocks.allowed.mockResolvedValue(false);
    const result = await updateSession(new NextRequest("https://example.com/dashboard?error=callback_failed"));
    expect(result.headers.get("location")).toContain("/login?error=not_allowed");
  });
});
describe("未ログイン時のcallbackUrl（#5035）", () => {
  it("Issue詳細リンクのクエリを保ったままログインへ送る", async () => {
    mocks.user = null;
    const result = await updateSession(
      new NextRequest("https://example.com/dashboard?issue=1&mscreen=issue-detail&missue=1"),
    );
    const location = new URL(result.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackUrl")).toBe("/dashboard?issue=1&mscreen=issue-detail&missue=1");
  });
});
