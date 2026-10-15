import { NextResponse, type NextRequest } from "next/server";

import { authenticateReviewAgent } from "@/lib/review-agent/auth";
import { listReviewAgentTools } from "@/lib/review-agent/service";

/** 外部エージェント向けAPI（#4588）のツール一覧。MCPの`tools/list`と同じ定義 */
export async function GET(request: NextRequest) {
  const auth = await authenticateReviewAgent(request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.code }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="issue-deck-review-agent"', "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ tools: listReviewAgentTools() }, { headers: { "Cache-Control": "no-store" } });
}
