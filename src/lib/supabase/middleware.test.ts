import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock("@/lib/access/client", () => ({ isUserAllowed: mocks.allowed }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: {
  getUser: async () => ({ data: { user: { id: "test" } } }),
} }) }));
vi.mock("@/lib/ci-auth-bypass", () => ({ CI_BYPASS_COOKIE_NAME: "test-ci", isCiBypassRequest: () => false }));
import { updateSession } from "./middleware";
beforeEach(() => mocks.allowed.mockResolvedValue(true));
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
