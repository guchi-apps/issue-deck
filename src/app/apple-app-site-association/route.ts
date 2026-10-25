import { NextResponse } from "next/server";

import { buildAppleAppSiteAssociation } from "@/lib/ios-universal-links";

// iOSが認証なし・リダイレクトなしで取得する（#5035）。`src/proxy.ts`のmatcherからも除外してある
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(buildAppleAppSiteAssociation(), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
