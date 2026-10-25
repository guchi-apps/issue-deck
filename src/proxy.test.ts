import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const updateSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/middleware", () => ({ updateSession }));
import proxy from "./proxy";

const BOT = "Mozilla/5.0 (compatible; Discordbot/2.0)";
const req = (path: string, ua: string) =>
  new NextRequest(`https://issuedeck.example${path}`, { headers: { "user-agent": ua } });

describe("proxy: リンクプレビューのrewrite", () => {
  it("クローラーの/dashboard?issue=は/share/issue/へrewriteし、認証を通さない", async () => {
    updateSession.mockClear();
    const res = await proxy(req("/dashboard?issue=123&mscreen=issue-detail", BOT));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/share/issue/123");
    expect(updateSession).not.toHaveBeenCalled();
  });
  it("人のブラウザは素通りで従来のupdateSessionへ", async () => {
    updateSession.mockClear();
    updateSession.mockResolvedValue(NextResponse.next());
    await proxy(req("/dashboard?issue=123", "Mozilla/5.0 Safari"));
    expect(updateSession).toHaveBeenCalledOnce();
  });
  it("クローラーでもissue=なし・不正値は素通り", async () => {
    updateSession.mockClear();
    updateSession.mockResolvedValue(NextResponse.next());
    await proxy(req("/dashboard", BOT));
    await proxy(req("/dashboard?issue=abc", BOT));
    expect(updateSession).toHaveBeenCalledTimes(2);
  });
});
