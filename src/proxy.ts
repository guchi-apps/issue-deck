import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

export default async function proxy(request: NextRequest) {
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
