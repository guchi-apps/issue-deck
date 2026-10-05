import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { sweepPrReviewResumes } from "@/lib/dispatch/pr-review-jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 確定したPRレビューの最終マージ判定を再開できていないものを再開する巡回（#3990）。
 *
 * サブPCのpollerが毎巡呼ぶ内部入口。レビューの完了報告でも再開を試みるが、Actionsのrunが
 * まだ実行中だと再実行できない。その取りこぼしと、`TIMEOUT`（サブPCが落ちたまま）で確定した
 * ものをここで拾う。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(
      { ok: true, ...(await sweepPrReviewResumes()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/dispatch/pr-review/resume-sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
