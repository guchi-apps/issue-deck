import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { prioritizeDispatchJob } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 順番待ちのジョブを先頭へ上げる（#1541）。
 *
 * **取り消し（`[id]/cancel`）とも表示消し（`[id]/dismiss`）とも別の操作。** どちらもジョブを
 * 終わらせる側で、こちらは順番を入れ替えるだけ。押せるのは順番待ちの起動ジョブに限られ、
 * 判定は`prioritizeDispatchJob`が持つ（理由は本文でそのまま返す）。
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await prioritizeDispatchJob({ jobId: id });

  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return NextResponse.json(
      { error: result.reason, message: result.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
