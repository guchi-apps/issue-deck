import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(), setSession: vi.fn(), signOut: vi.fn(), allowed: vi.fn(),
  consume: vi.fn(), decrypt: vi.fn(),
}));
vi.mock("@/lib/access/client", () => ({ isUserAllowed: mocks.allowed }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  signInWithOAuth: mocks.signInWithOAuth, setSession: mocks.setSession, signOut: mocks.signOut,
} }) }));
vi.mock("@/lib/native-auth/handoff", () => ({ consumeHandoff: mocks.consume }));
vi.mock("@/lib/native-auth/cipher", () => ({ decryptSession: mocks.decrypt }));
vi.mock("@/lib/native-auth/stores", () => ({ handoffStore: {} }));
import { GET as start } from "./start/route";
import { POST as consume } from "./consume/route";

const challenge = "A".repeat(43);
const verifier = "v".repeat(64);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/auth/native/start", () => {
  it("Web版と同じGitHubのスコープでOAuthを始め、戻り先へnative・challenge・安全なnextを運ぶ", async () => {
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: "https://github.example/authorize" }, error: null });
    const res = await start(new NextRequest(`https://example.com/auth/native/start?challenge=${challenge}&next=%2Fissues`));
    expect(res.headers.get("location")).toBe("https://github.example/authorize");
    const options = mocks.signInWithOAuth.mock.calls[0][0];
    expect(options.provider).toBe("github");
    expect(options.options.scopes).toBe("repo user:email");
    const redirect = new URL(options.options.redirectTo);
    expect(redirect.pathname).toBe("/auth/callback");
    expect(redirect.searchParams.get("native")).toBe("1");
    expect(redirect.searchParams.get("challenge")).toBe(challenge);
    expect(redirect.searchParams.get("next")).toBe("/issues");
  });

  it("challengeの形が違えばOAuthを始めずアプリのスキームへ失敗で戻す", async () => {
    const res = await start(new NextRequest("https://example.com/auth/native/start?challenge=bad"));
    expect(res.headers.get("location")).toBe("issuedeck://auth-callback?error=auth_failed");
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("外部URLのnextは通さない", async () => {
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: "https://github.example/a" }, error: null });
    await start(new NextRequest(`https://example.com/auth/native/start?challenge=${challenge}&next=%2F%2Fevil.example`));
    const redirect = new URL(mocks.signInWithOAuth.mock.calls[0][0].options.redirectTo);
    expect(redirect.searchParams.get("next")).toBe("/dashboard");
  });
});

const post = (body: unknown) => new NextRequest("https://example.com/auth/native/consume", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("/auth/native/consume", () => {
  it("形の違う本文・不正なverifierは理由を区別せず400にする", async () => {
    expect((await consume(post("not json"))).status).toBe(400);
    expect((await consume(post({ code: "c", verifier: "short" }))).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("消費できないコードは400", async () => {
    mocks.consume.mockResolvedValue(null);
    expect((await consume(post({ code: "c", verifier }))).status).toBe(400);
  });

  it("許可されたユーザーにはセッションを渡し、安全なnextを返す", async () => {
    mocks.consume.mockResolvedValue({ sessionCipher: "x", next: "/issues" });
    mocks.decrypt.mockReturnValue(JSON.stringify({ accessToken: "a", refreshToken: "r" }));
    mocks.setSession.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    mocks.allowed.mockResolvedValue(true);
    const res = await consume(post({ code: "c", verifier }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/issues" });
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r" });
  });

  it("許可から外れたユーザーは403で、このアプリのセッションだけ破棄する", async () => {
    mocks.consume.mockResolvedValue({ sessionCipher: "x", next: null });
    mocks.decrypt.mockReturnValue(JSON.stringify({ accessToken: "a", refreshToken: "r" }));
    mocks.setSession.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    mocks.allowed.mockResolvedValue(false);
    const res = await consume(post({ code: "c", verifier }));
    expect(res.status).toBe(403);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
