import { NextResponse, type NextRequest } from "next/server";

import { authorizeAiUsage, getAiUsageSummary } from "@/lib/ai-usage-export";

/** ops-dashboardの「アプリ別のAI利用」へ、Claude・OpenAI・Jevをモデル別に公開する。 */
export function GET(request: NextRequest) {
  const auth = authorizeAiUsage(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getAiUsageSummary(), {
    headers: { "Cache-Control": "no-store" },
  });
}
