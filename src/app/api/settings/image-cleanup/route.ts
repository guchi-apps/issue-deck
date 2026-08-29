import { NextResponse, type NextRequest } from "next/server";

import { IMAGE_RETENTION_DAYS_DEFAULT, parseImageRetentionDays } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { imageTrashDays } from "@/lib/images/image-cleanup";
import type { UploadedImageCleanupSettings } from "@/types/uploaded-image";

/**
 * 参照されていない添付画像の自動削除の設定（#2475）。
 *
 * **「実行設定」区分の保存ボタンには載せない。** 設定の「画像」区分は保存を押すまで効かない値を
 * 持たない区分（`settings-sections.ts`）で、この2つも切り替えた時点で保存する。効くのは
 * 次の巡回からで、押した瞬間に何かが消えるわけではない。
 */
export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const enabled = payload?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 保持日数は省略可（トグルだけを切り替えるとき）
  const retentionDays =
    payload?.retentionDays === undefined ? null : parseImageRetentionDays(payload.retentionDays);
  if (payload?.retentionDays !== undefined && retentionDays === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      imageCleanupEnabled: enabled,
      imageRetentionDays: retentionDays ?? IMAGE_RETENTION_DAYS_DEFAULT,
    },
    update: {
      imageCleanupEnabled: enabled,
      ...(retentionDays === null ? {} : { imageRetentionDays: retentionDays }),
    },
  });

  const settings: UploadedImageCleanupSettings = {
    enabled: updated.imageCleanupEnabled,
    retentionDays: updated.imageRetentionDays,
    trashDays: imageTrashDays(),
  };
  return NextResponse.json(settings);
}
