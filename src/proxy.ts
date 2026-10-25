import { NextResponse, type NextRequest } from "next/server";

import { isLinkPreviewBot, resolveSharePath } from "@/lib/share-card";
import { updateSession } from "@/lib/supabase/middleware";

export default async function proxy(request: NextRequest) {
  // Discordなどのリンクプレビューのクローラーは未ログインなので、`/dashboard?issue=`・`?pr=`を
  // 取りに来ると`/login`へ転送されて何も読めない（#5036）。**認証の判定（updateSession）より前**に、
  // クローラーUAで`issue=`・`pr=`が妥当な形のときだけ、リポジトリ名と種別・番号だけを返す
  // `/share/...`へrewriteする。人のアクセスはここを素通りして従来どおりログイン・権限チェックを受ける。
  if (request.nextUrl.pathname === "/dashboard" && isLinkPreviewBot(request.headers.get("user-agent"))) {
    const sharePath = resolveSharePath(request.nextUrl.searchParams);
    if (sharePath) {
      const url = request.nextUrl.clone();
      url.pathname = sharePath;
      url.search = "";
      return NextResponse.rewrite(url);
    }
  }
  return updateSession(request);
}

// `sw.js`（Service Worker。#838）は`manifest.webmanifest`と同じく**ログイン前にも素の
// ファイルとして返す必要がある**。ここを通すと、Supabaseのセッションが切れた状態で
// ブラウザが更新チェックをしたときに`/login`のHTMLが返り、MIMEタイプ不一致で
// Service Workerの更新が落ちる（＝Push通知が届かなくなる）。中身は静的な定型文で、
// ユーザー固有の情報を持たない。
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|apple-icon|icon|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)",
  ],
};
