import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { getRequestOrigin } from "@/lib/request-origin";
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
  const metadata = user.user_metadata as Record<string, unknown>;

  const githubUserId = Number(metadata.provider_id ?? metadata.sub);
  const githubLogin = String(metadata.user_name ?? metadata.preferred_username ?? "");

  if (!githubUserId || !githubLogin) {
    return NextResponse.redirect(`${origin}/login`);
  }

  await db.user.upsert({
    where: { supabaseUserId: user.id },
    create: {
      supabaseUserId: user.id,
      githubUserId,
      githubLogin,
      name: (metadata.full_name as string) ?? (metadata.name as string) ?? null,
      email: user.email ?? null,
      image: (metadata.avatar_url as string) ?? null,
    },
    update: {
      githubLogin,
      name: (metadata.full_name as string) ?? (metadata.name as string) ?? null,
      email: user.email ?? null,
      image: (metadata.avatar_url as string) ?? null,
    },
  });

  return NextResponse.redirect(`${origin}${next}`);
}
