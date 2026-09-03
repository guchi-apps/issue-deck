import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 夜間実行の予定を取り消す（#2772）。**取り消せるのは未処理（QUEUED）だけ。**
 *
 * 起動ジョブへ変換した後（LAUNCHED）の取り消しは実行キューの側（`POST /api/dispatch/<id>/cancel`・
 * 「停止」）が受け持つ。積む時点で付けたオプションのラベルは外さない（「実装を開始」で
 * 積めなかったときと同じ扱い。人が外す）。
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const result = await db.nightlyRunEntry.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "CANCELED", activeKey: null, nightKey: null, resolvedAt: new Date() },
  });
  if (result.count === 0) {
    return NextResponse.json(
      { error: "not_found", message: "取り消せる予定が見つかりません（すでに起動したか、取り消し済みです）" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
