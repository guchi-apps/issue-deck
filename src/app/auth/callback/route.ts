import { NextResponse, type NextRequest } from "next/server";

import { isUserAllowed } from "@/lib/access/client";
import { encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { fetchVerifiedGithubProfile } from "@/lib/auth/github-profile";
import { getRequestOrigin } from "@/lib/request-origin";
import { toSafeRedirectPath } from "@/lib/safe-redirect-path";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = getRequestOrigin(request);
  const code = searchParams.get("code");
  const next = toSafeRedirectPath(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const supabase = await createClient();
  let stage = "code_exchange";
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user) throw new Error("code_exchange_failed");
    const { user } = data;

    stage = "access_decision";
    if (!(await isUserAllowed(user))) {
      // 共用のSupabaseユーザーは削除しない。他アプリのセッションも失効させない。
      await supabase.auth.signOut({ scope: "local" });
      return NextResponse.redirect(`${origin}/login?error=not_allowed`);
    }

    // user_metadataは利用者が編集可能。既存データの再紐付けの根拠には使わず、
    // 今回のOAuthで取得したトークンをGitHub自身へ照会して本人の不変IDを確認する。
    const providerToken = data.session?.provider_token;
    stage = "github_identity";
    const profile = await fetchVerifiedGithubProfile(providerToken);
    const values = {
      supabaseUserId: user.id,
      githubLogin: profile.login,
      name: profile.name,
      email: user.email ?? null,
      image: profile.avatar_url,
      githubAccessToken: encryptSecret(providerToken!),
      githubRefreshToken: data.session?.provider_refresh_token
        ? encryptSecret(data.session.provider_refresh_token)
        : null,
    };

    // 同時ログインによるcreate競合・直列化競合だけを有限回再試行する。
    stage = "user_save";
    for (let attempt = 0; ; attempt++) {
      try {
        await db.$transaction(async (tx) => {
          const linked = await tx.user.findUnique({ where: { supabaseUserId: user.id } });
          if (linked && linked.githubUserId !== profile.id) {
            throw new Error("identity_conflict");
          }
          // User.idを維持して更新するため、設定・履歴・連携の外部キーは変わらない。
          await tx.user.upsert({
            where: { githubUserId: profile.id },
            create: { ...values, githubUserId: profile.id },
            update: values,
          });
        }, { isolationLevel: "Serializable" });
        break;
      } catch (error) {
        const retryable = typeof error === "object" && error !== null && "code" in error
          && (error.code === "P2002" || error.code === "P2034");
        if (!retryable || attempt >= 2) throw error;
      }
    }
    return NextResponse.redirect(`${origin}${next}`);
  } catch {
    // Prisma例外やOAuth応答には個人情報・秘密が含まれ得るので丸ごと記録しない。
    console.error("[auth/callback] ログイン完了処理に失敗しました", { stage });
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // セッション失効自体が失敗しても、白画面にせず再試行の入口を返す。
    }
    return NextResponse.redirect(`${origin}/login?error=callback_failed`);
  }
}
