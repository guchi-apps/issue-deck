import { NextResponse, type NextRequest } from "next/server";

import { CI_BYPASS_COOKIE_NAME } from "@/lib/ci-auth-bypass";
import { isDevLoginEnabled } from "@/lib/dev-login";
import { getRequestOrigin } from "@/lib/request-origin";

/**
 * 開発用ログイン（#1473）。CIバイパス用のCookieを立てて`/dashboard`へ送るだけ。
 *
 * 入れるのは`pnpm db:seed:dev`が投入したダミーデータに紐づくバイパス用ユーザー
 * （`ci-screenshot-bot`）で、実ユーザーのデータ・実GitHubトークンには到達しない。
 *
 * **本番では常に404**（`isDevLoginEnabled`が`NODE_ENV=production`で偽になる）。
 * `/api/*`は`src/proxy.ts`→`updateSession`を素通りする設計のため、middleware側の
 * 追加設定は要らない。
 */
export async function POST(request: NextRequest) {
  if (!isDevLoginEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const response = NextResponse.redirect(`${getRequestOrigin(request)}/dashboard`, {
    // POSTのリダイレクトをGETで追わせる（既定の307だとブラウザがPOSTのまま再送する）。
    status: 303,
  });

  response.cookies.set(CI_BYPASS_COOKIE_NAME, process.env.CI_LOGIN_BYPASS_SECRET ?? "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  return response;
}
