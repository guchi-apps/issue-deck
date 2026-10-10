import { NextResponse, type NextRequest } from "next/server";

import { isUserAllowed } from "@/lib/access/client";
import { decryptSession } from "@/lib/native-auth/cipher";
import { consumeHandoff } from "@/lib/native-auth/handoff";
import { handoffStore } from "@/lib/native-auth/stores";
import { isValidVerifier } from "@/lib/native-auth/tokens";
import { toSafeRedirectPath } from "@/lib/safe-redirect-path";
import { createClient } from "@/lib/supabase/server";

/**
 * 引き継ぎコードを消費して、WKWebViewへ通常のSupabase SSR Cookieを渡す（#3846）。
 *
 * WKWebViewの中から `fetch`（同一オリジン・POST）で呼ぶ。コードとcode_verifierはURLではなく
 * 本文で受けるため、アクセスログに残らない。失敗の理由は区別せず同じ応答にする。
 * ユーザー・GitHubトークンの保存は`/auth/callback`で済んでいる。ここはセッションの受け渡しだけ。
 */
export async function POST(request: NextRequest) {
  const rejected = () => NextResponse.json({ error: "invalid_handoff" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rejected();
  }
  const record = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const verifier = record?.verifier;
  if (!code || !isValidVerifier(verifier)) return rejected();

  const handoff = await consumeHandoff({ store: handoffStore, code, verifier, now: new Date() });
  if (!handoff) return rejected();

  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = JSON.parse(decryptSession(handoff.sessionCipher));
  } catch {
    return rejected();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error || !data.user) return rejected();

  // 発行後に許可から外れた場合に備え、ここでも確かめる。共有のSupabaseユーザーは消さず、
  // このアプリのセッションだけを破棄する。
  if (!(await isUserAllowed(data.user))) {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.json({ error: "not_allowed" }, { status: 403 });
  }

  return NextResponse.json({ next: toSafeRedirectPath(handoff.next) });
}
