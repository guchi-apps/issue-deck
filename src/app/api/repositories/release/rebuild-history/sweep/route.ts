import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";
import { sweepAllCompletedRebuildHistory } from "@/lib/release-rebuild-history-run";

/**
 * サブPCのpollerが、完了したリリースの作り直し履歴（#4420）を掃除するための内部入口。
 * リリースがmainへマージされ（iOSアプリのあるリポジトリはTestFlight配布も済み）、完了したと判定できた
 * 経過の履歴を削除する。画面を開かないリポジトリの履歴も残さないため、画面の取得ではなく巡回で行う。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(
      { ok: true, ...(await sweepAllCompletedRebuildHistory()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/repositories/release/rebuild-history/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
