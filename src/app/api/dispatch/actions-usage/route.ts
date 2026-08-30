import { NextResponse, type NextRequest } from "next/server";

import { parseActionsUsagePayload, storeActionsUsage } from "@/lib/dispatch/actions-usage";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/** GitHub ActionsからClaude Codeの数値だけを受け取る。計測失敗でActions本体を止めない。 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const reports = parseActionsUsagePayload(payload);
  if (!reports) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const stored = await storeActionsUsage(reports);
  return NextResponse.json({ ok: true, stored }, { headers: { "Cache-Control": "no-store" } });
}
