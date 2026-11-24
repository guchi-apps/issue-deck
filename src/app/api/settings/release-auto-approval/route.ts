import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { previewModeGuard } from "@/lib/preview-mode";
import { readReleaseAutoApprovalEnabled } from "@/lib/release-auto-approval-run";

/**
 * RCの公開承認の自動化（#5629）の設定。切り替えた時点で保存し、効くのは次の巡回から。
 * 既定はOFF（人が納得してから有効にする）。判断の条件は`src/lib/release-auto-approval.ts`
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await readReleaseAutoApprovalEnabled() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const enabled = payload?.enabled;
  if (typeof enabled !== "boolean") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, releaseAutoApprovalEnabled: enabled },
    update: { releaseAutoApprovalEnabled: enabled },
  });
  return NextResponse.json({ enabled: updated.releaseAutoApprovalEnabled });
}
