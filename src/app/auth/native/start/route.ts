import { NextResponse, type NextRequest } from "next/server";

import { nativeLoginErrorUrl } from "@/lib/native-auth/native-app";
import { isValidChallenge } from "@/lib/native-auth/tokens";
import { getRequestOrigin } from "@/lib/request-origin";
import { toSafeRedirectPath } from "@/lib/safe-redirect-path";
import { createClient } from "@/lib/supabase/server";

/**
 * iOSアプリの認証シート（ASWebAuthenticationSession）から開くGitHubログインの入口（#3846）。
 *
 * Web版（`startGithubOAuth`）と同じプロバイダー・スコープでSupabaseのOAuthを始め、戻り先の
 * `/auth/callback` へ `native=1` とアプリの `challenge`（code_verifierのS256）を運ぶ。
 * callbackは既存と同じ経路（許可判定・本人確認・GitHubトークンの暗号化保存）を通したあと、
 * 最後のリダイレクト先だけを変え、トークンではなく一度限りの引き継ぎコードをアプリのスキームへ返す。
 */
export async function GET(request: NextRequest) {
  const origin = getRequestOrigin(request);
  const challenge = request.nextUrl.searchParams.get("challenge");

  if (!isValidChallenge(challenge)) {
    return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));
  }

  const next = toSafeRedirectPath(request.nextUrl.searchParams.get("next"));

  const callback = new URL(`${origin}/auth/callback`);
  callback.searchParams.set("native", "1");
  callback.searchParams.set("challenge", challenge);
  callback.searchParams.set("next", next);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callback.toString(), scopes: "repo user:email", skipBrowserRedirect: true },
  });

  if (error || !data.url) {
    console.error("[auth/native/start] iOSアプリのGitHubログイン開始に失敗しました");
    return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));
  }

  return NextResponse.redirect(data.url);
}
