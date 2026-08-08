import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/allowed-emails";
import { encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { getRequestOrigin } from "@/lib/request-origin";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = getRequestOrigin(request);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const { user } = data;

  if (!isEmailAllowed(user.email)) {
    await supabase.auth.signOut();
    const admin = createAdminClient();
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      console.error("[auth/callback] failed to delete disallowed Supabase Auth user", deleteError);
    }
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  const metadata = user.user_metadata as Record<string, unknown>;

  const githubUserId = Number(metadata.provider_id ?? metadata.sub);
  const githubLogin = String(metadata.user_name ?? metadata.preferred_username ?? "");

  if (!githubUserId || !githubLogin) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const providerToken = data.session?.provider_token;
  const githubAccessToken = providerToken ? encryptSecret(providerToken) : undefined;
  // Supabase Auth側の設定（GitHub Appの「Expire user authorization tokens」有効時のみ）によっては
  // 払い出されない。無い場合はundefinedのままにし、自動延長機能のみ無効化する
  const providerRefreshToken = data.session?.provider_refresh_token;
  const githubRefreshToken = providerRefreshToken ? encryptSecret(providerRefreshToken) : undefined;

  await db.user.upsert({
    where: { supabaseUserId: user.id },
    create: {
      supabaseUserId: user.id,
      githubUserId,
      githubLogin,
      name: (metadata.full_name as string) ?? (metadata.name as string) ?? null,
      email: user.email ?? null,
      image: (metadata.avatar_url as string) ?? null,
      githubAccessToken,
      githubRefreshToken,
    },
    update: {
      githubLogin,
      name: (metadata.full_name as string) ?? (metadata.name as string) ?? null,
      email: user.email ?? null,
      image: (metadata.avatar_url as string) ?? null,
      ...(githubAccessToken ? { githubAccessToken } : {}),
      ...(githubRefreshToken ? { githubRefreshToken } : {}),
    },
  });

  return NextResponse.redirect(`${origin}${next}`);
}
