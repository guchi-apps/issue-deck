import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseCodexUsageReport, storeCodexUsage } from "@/lib/dispatch/codex-usage";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";

/** Codexを実行するホストから、転記に含まれる最新のプラン枠だけを受け取る（#2535）。 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const host = parseDispatchHostName((payload as { host?: unknown } | null)?.host);
  const report = parseCodexUsageReport(payload);
  if (!host || !report) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  await storeCodexUsage(host, report);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
