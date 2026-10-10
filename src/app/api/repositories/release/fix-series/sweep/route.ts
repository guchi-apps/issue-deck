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
  try {
    return NextResponse.json({ ok: true, ...(await runReleaseFixSweep()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/repositories/release/fix-series/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
