import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(), signOut: vi.fn(), allowed: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), issue: vi.fn(),
}));
vi.mock("@/lib/access/client", () => ({ isUserAllowed: mocks.allowed }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  exchangeCodeForSession: mocks.exchange, signOut: mocks.signOut,
} }) }));
vi.mock("@/lib/crypto/secret-cipher", () => ({ encryptSecret: (s: string) => `encrypted:${s}` }));
vi.mock("@/lib/native-auth/cipher", () => ({ encryptSession: (s: string) => `session:${s}` }));
vi.mock("@/lib/native-auth/handoff", () => ({ issueHandoff: mocks.issue }));
vi.mock("@/lib/native-auth/stores", () => ({ handoffStore: {} }));
vi.mock("@/lib/db", () => ({ db: { $transaction: async (fn: (tx: unknown) => unknown) =>
  fn({ user: { findUnique: mocks.findUnique, upsert: mocks.upsert } }) } }));
import { GET } from "./route";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const request = () => new NextRequest("https://example.com/auth/callback?code=test&next=%2Fdashboard");
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.exchange.mockResolvedValue({ data: {
    user: { id: "new-auth-id", email: "test@example.invalid", user_metadata: { provider_id: "999" } },
    session: { provider_token: "test-provider-token", access_token: "at", refresh_token: "rt" },
  }, error: null });
  mocks.allowed.mockResolvedValue(true);
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.findUnique.mockResolvedValue(null);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 42, login: "verified-user" })));
});

describe("ログイン完了処理", () => {
  it("認証ID再作成後もGitHubの確認済みIDで既存行を更新し、設定と履歴を保持する", async () => {
    const existing = { id: "existing-user", githubUserId: 42, supabaseUserId: "old-auth-id", settings: ["saved"] };
    mocks.upsert.mockImplementation(async ({ where, update }) => {
      // 旧実装のsupabaseUserId検索なら新規作成に進み、本番と同じ一意制約違反になる。
      if (where.githubUserId !== existing.githubUserId) throw { code: "P2002" };
      Object.assign(existing, update);
      return existing;
    });
    const response = await GET(request());
    expect(response.headers.get("location")).toBe("https://example.com/dashboard");
    expect(existing).toMatchObject({ id: "existing-user", supabaseUserId: "new-auth-id", settings: ["saved"] });
    expect(mocks.upsert.mock.calls[0][0].update.githubRefreshToken).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("許可のないユーザーはDB更新も認証ユーザー削除もせず、当該セッションだけ終了する", async () => {
    mocks.allowed.mockResolvedValue(false);
    expect((await GET(request())).headers.get("location")).toContain("error=not_allowed");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("既存の認証IDが別GitHubユーザーへ紐付くときは統合しない", async () => {
    mocks.findUnique.mockResolvedValue({ githubUserId: 99 });
    expect((await GET(request())).headers.get("location")).toContain("error=callback_failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("GitHubの本人確認が失敗したら編集可能なmetadataへフォールバックしない", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    expect((await GET(request())).headers.get("location")).toContain("error=callback_failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("初回ログインも確認済みIDで作成する", async () => {
    expect((await GET(request())).headers.get("location")).toContain("/dashboard");
    expect(mocks.upsert.mock.calls[0][0].create).toMatchObject({ githubUserId: 42, githubLogin: "verified-user" });
  });

  it.each(["P2002", "P2034"])("同時ログインの競合 %s は再試行できる", async (code) => {
    mocks.upsert.mockRejectedValueOnce({ code }).mockResolvedValueOnce({ id: "existing" });
    expect((await GET(request())).headers.get("location")).toContain("/dashboard");
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
  });

  it("永続的な保存エラーもログアウトの例外も白画面にせず、秘密をログへ出さない", async () => {
    mocks.upsert.mockRejectedValue({ code: "P2002", secret: "must-not-log" });
    mocks.signOut.mockRejectedValue(new Error("signout failed"));
    expect((await GET(request())).headers.get("location")).toContain("error=callback_failed");
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("must-not-log");
  });

  it("コード交換失敗は再ログインへ戻す", async () => {
    mocks.exchange.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    expect((await GET(request())).headers.get("location")).toContain("error=callback_failed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  describe("iOSアプリの認証シート（native=1）", () => {
    const challenge = "A".repeat(43);
    const nativeRequest = () => new NextRequest(
      `https://example.com/auth/callback?code=test&next=%2Fissues&native=1&challenge=${challenge}`);

    it("既存と同じ経路でGitHubトークンを保存してから、引き継ぎコードだけをアプリへ返す", async () => {
      mocks.upsert.mockResolvedValue({ id: "u" });
      mocks.issue.mockResolvedValue("handoff-code");
      const res = await GET(nativeRequest());
      expect(res.headers.get("location")).toBe("issuedeck://auth-callback?code=handoff-code");
      expect(mocks.upsert.mock.calls[0][0].update.githubAccessToken).toBe("encrypted:test-provider-token");
      const issued = mocks.issue.mock.calls[0][0];
      expect(issued.challenge).toBe(challenge);
      expect(issued.next).toBe("/issues");
      expect(issued.sessionCipher).toContain("\"accessToken\":\"at\"");
      expect(res.headers.get("location")).not.toContain("at");
    });

    it("許可のないユーザーはDB保存も引き継ぎもせず、アプリへnot_allowedで戻す", async () => {
      mocks.allowed.mockResolvedValue(false);
      const res = await GET(nativeRequest());
      expect(res.headers.get("location")).toBe("issuedeck://auth-callback?error=not_allowed");
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.issue).not.toHaveBeenCalled();
    });

    it("GitHubの本人確認に失敗したらアプリへauth_failedで戻す", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 401 }));
      const res = await GET(nativeRequest());
      expect(res.headers.get("location")).toBe("issuedeck://auth-callback?error=auth_failed");
      expect(mocks.issue).not.toHaveBeenCalled();
    });

    it("challengeが不正ならnativeとして扱わず通常のWebの戻り先にする", async () => {
      mocks.upsert.mockResolvedValue({ id: "u" });
      const res = await GET(new NextRequest("https://example.com/auth/callback?code=test&next=%2Fissues&native=1&challenge=bad"));
      expect(res.headers.get("location")).toBe("https://example.com/issues");
      expect(mocks.issue).not.toHaveBeenCalled();
    });
  });
});
