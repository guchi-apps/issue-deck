import { NextResponse } from "next/server";

import packageJson from "../../../../package.json";

// PWAとしてホーム画面に追加した状態でも再インストールなしに新バージョンへ
// 追従できるよう、クライアント（AppUpdateChecker）がこのエンドポイントを
// ポーリングしてデプロイ済みのバージョンと比較する。CDN/ブラウザにキャッシュ
// されると新バージョンを検知できなくなるため常に無効化する。
export const dynamic = "force-dynamic";

/**
 * 稼働しているコミットのSHA（#4007）。`deploy.yml`が`.env`へ書く`APP_COMMIT_SHA`を返す。
 * デプロイのヘルスチェックはこれが今回のコミットと一致するまで成功にしない（旧版がHTTP 200を
 * 返しているだけの状態を成功と見なさないため）。ローカル開発など未設定ならnull。
 */
export async function GET() {
  return NextResponse.json(
    { version: packageJson.version, sha: process.env.APP_COMMIT_SHA || null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
