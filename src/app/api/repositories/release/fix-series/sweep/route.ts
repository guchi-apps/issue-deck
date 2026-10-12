import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";
import { runReleaseFixSweep } from "@/lib/release-fix-series-run";

/** サブPCのpollerがリリース候補の修正系列（#4317）を進めるための内部入口 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // 次世代の修正Issueの実装をこのホストで起動する（#4478）。省略時は起動せず、画面の「修正を開始」に任せる
  const payload = await request.json().catch(() => null);
  const hostName = typeof payload?.host === "string" && payload.host !== "" ? payload.host : null;
  try {
    return NextResponse.json({ ok: true, ...(await runReleaseFixSweep({ hostName })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/repositories/release/fix-series/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
