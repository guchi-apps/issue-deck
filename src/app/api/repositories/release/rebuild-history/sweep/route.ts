import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";
import { reconcileAllReleasePreparationFailures } from "@/lib/release-preparation-run";
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
    const history = await sweepAllCompletedRebuildHistory();
    // 履歴の有無と無関係に、後続のリリース成功で解消済みの準備失敗を解決へ倒す（#4450）
    const resolvedFailures = await reconcileAllReleasePreparationFailures();
    return NextResponse.json(
      { ok: true, ...history, resolvedFailures },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/repositories/release/rebuild-history/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
