import { NextResponse, type NextRequest } from "next/server";

import { authenticateReviewAgent } from "@/lib/review-agent/auth";
import { callReviewAgentTool } from "@/lib/review-agent/service";

/**
 * 外部エージェント向けAPI（#4588）。ボディがツールの引数。読み取りのツールも同じ形で呼ぶ（副作用なし）。
 * ブラウザのログインは使わず`Authorization: Bearer ida_…`だけで認証する。MCP（`/api/mcp/review-agent`）と同じ`callReviewAgentTool`を通る。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const noStore = { "Cache-Control": "no-store" };
  const auth = await authenticateReviewAgent(request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.code }, { status: 401, headers: { ...noStore, "WWW-Authenticate": 'Bearer realm="issue-deck-review-agent"' } });
  }
  const { name } = await context.params;
  const args = await request.json().catch(() => null);
  if (args !== null && (typeof args !== "object" || Array.isArray(args))) {
    return NextResponse.json({ error: "invalid_request", message: "ボディはJSONオブジェクトで指定してください" }, { status: 400, headers: noStore });
  }
  const result = await callReviewAgentTool(auth.principal, name, args ?? {});
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message, refetchRequired: result.refetchRequired ?? false, ...(result.details ? { details: result.details } : {}) },
      { status: result.status, headers: noStore },
    );
  }
  return NextResponse.json({ ok: true, ...(result.replayed ? { replayed: true } : {}), data: result.data }, { headers: noStore });
}
