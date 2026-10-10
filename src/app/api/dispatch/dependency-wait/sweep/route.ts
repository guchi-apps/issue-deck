import { NextResponse, type NextRequest } from "next/server";

import { runDependencyWaitSweep } from "@/lib/dispatch/dependency-wait-run";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * サブPCのpollerが依存待ち（#4321）を定期照合する内部入口。イベントの欠落・サービス再起動で
 * 取りこぼした条件成立を回収し、再開の追跡（送信→実際の再開確認）も進める。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(
      { ok: true, ...(await runDependencyWaitSweep()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/dispatch/dependency-wait/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
