import { NextResponse } from "next/server";

import packageJson from "../../../../package.json";

// PWAとしてホーム画面に追加した状態でも再インストールなしに新バージョンへ
// 追従できるよう、クライアント（AppUpdateChecker）がこのエンドポイントを
// ポーリングしてデプロイ済みのバージョンと比較する。CDN/ブラウザにキャッシュ
// されると新バージョンを検知できなくなるため常に無効化する。
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { version: packageJson.version },
    { headers: { "Cache-Control": "no-store" } },
  );
}
