import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { runParentRunSweep } from "@/lib/parent-run/run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * サブPCのpollerが親Issueの自動実行（#4536）を定期評価する内部入口。着手条件の再評価・次の子の起動・
 * 取りこぼした条件成立の回収をする。巡回の競合は実行ごとの`lastSweepAt`の条件付き更新で弾く。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await runParentRunSweep()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/parent-run/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
