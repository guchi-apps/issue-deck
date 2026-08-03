import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isEmailAllowed } from "@/lib/allowed-emails";
import { CI_BYPASS_COOKIE_NAME, isCiBypassRequest } from "@/lib/ci-auth-bypass";
import { getRequestOrigin } from "@/lib/request-origin";

const publicPaths = ["/login", "/auth/callback"];

function isPublicPath(pathname: string): boolean {
  return publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  if (isCiBypassRequest(request.cookies.get(CI_BYPASS_COOKIE_NAME)?.value)) {
    return supabaseResponse;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // 一度許可されてログイン済みのユーザーが、後で許可リストから外れたケースへの多層防御。
  // /auth/callback側で新規ログイン時点では弾いているが、既存セッションはここで塞ぐ。
  // 許可されないユーザーは以降 user なし（＝未ログイン）と同様に扱う。
  const allowedUser = user && isEmailAllowed(user.email) ? user : null;

  // /api/* はルートハンドラ自身が requireUserId() で認証チェックし、
  // 401 JSON を返す設計のため、ここではリダイレクトせず素通りさせる。
  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  // ログイン済みユーザーが /login を開いた場合（ブラウザの「戻る」操作等）は
  // ログイン画面を再表示せずダッシュボードへ送り、URL上もログイン前の状態に
  // 戻れてしまわないようにする。
  if (pathname === "/login" && allowedUser) {
    const callbackUrl = request.nextUrl.searchParams.get("callbackUrl");
    const target = callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/dashboard";
    return NextResponse.redirect(new URL(target, getRequestOrigin(request)));
  }

  if (isPublicPath(pathname)) {
    return supabaseResponse;
  }

  if (!allowedUser) {
    const loginUrl = new URL("/login", getRequestOrigin(request));
    if (user) {
      loginUrl.searchParams.set("error", "not_allowed");
    } else {
      loginUrl.searchParams.set("callbackUrl", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}
