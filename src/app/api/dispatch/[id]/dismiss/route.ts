import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { dismissDispatchJob } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 終了したジョブの表示を実行キューから消す（#1479）。
 *
 * **取り消し（`[id]/cancel`）とは別の操作。** あちらは走る前のジョブを止めるもので、こちらは
 * 既に終わったジョブの表示を畳むだけ。行は消さず`dismissedAt`を入れる（失敗理由は残す）。
 * 未完了のジョブを渡した場合は`dismissDispatchJob`が理由を本文で返す。
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await dismissDispatchJob({ jobId: id });

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
