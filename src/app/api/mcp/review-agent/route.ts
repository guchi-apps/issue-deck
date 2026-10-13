import { NextResponse, type NextRequest } from "next/server";

import { handleMcpMessage, type JsonRpcResponse } from "@/lib/review-agent/mcp";
import { authenticateReviewAgent } from "@/lib/review-agent/auth";

/**
 * 全体レビュー・修正の外部エージェント向けMCPサーバー（#4588。Streamable HTTP）。
 * 接続: `claude mcp add --transport http issue-deck-review <このURL> --header "Authorization: Bearer ida_…"`
 * 認証はAPIと同じ専用トークン。トークンが無効なときはJSON-RPCではなくHTTP 401＋`WWW-Authenticate`を返す（クライアントが接続の失敗として扱える）。
 */
const noStore = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const auth = await authenticateReviewAgent(request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.code }, { status: 401, headers: { ...noStore, "WWW-Authenticate": 'Bearer realm="issue-deck-review-agent"' } });
  }
  const body = await request.json().catch(() => undefined);
  if (body === undefined) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: noStore });
  }
  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map((m) => handleMcpMessage(auth.principal, m)))).filter((r): r is JsonRpcResponse => r !== null);
    return results.length > 0 ? NextResponse.json(results, { headers: noStore }) : new NextResponse(null, { status: 202, headers: noStore });
  }
  const result = await handleMcpMessage(auth.principal, body);
  return result ? NextResponse.json(result, { headers: noStore }) : new NextResponse(null, { status: 202, headers: noStore });
}

/** SSEのストリームは提供しない（Streamable HTTPのうちPOSTだけに対応） */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...noStore, Allow: "POST" } });
}
