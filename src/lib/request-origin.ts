import type { NextRequest } from "next/server";

/**
 * Next.jsのrequest.url(nextUrl.origin)は、開発サーバーがWSL LAN経由・sslip.io経由など
 * 複数のホストから到達可能な場合、実際のブラウザのHostヘッダーを反映せずdevサーバーの
 * デフォルトホスト名を返すことがある。OAuthのリダイレクト先を組み立てる際は、実際に
 * リクエストされたHostヘッダーから明示的にoriginを組み立てる必要がある。
 */
export function getRequestOrigin(request: NextRequest): string {
  const host = request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "http";

  if (host) {
    return `${proto}://${host}`;
  }

  return new URL(request.url).origin;
}
