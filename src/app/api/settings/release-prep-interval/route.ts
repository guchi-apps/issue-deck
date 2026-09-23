import { NextResponse, type NextRequest } from "next/server";

import {
  RELEASE_PREP_INTERVAL_MINUTES_DEFAULT,
  parseReleasePrepIntervalMinutes,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * リリース準備の自動実行間隔（#3416）。画面の設定から読み書きする口。
 * ワークフローが読む口は`GET /api/release-prep/schedule`（共有シークレット認証）。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return NextResponse.json({
    releasePrepIntervalMinutes:
      setting?.releasePrepIntervalMinutes ?? RELEASE_PREP_INTERVAL_MINUTES_DEFAULT,
  });
}

export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const releasePrepIntervalMinutes = parseReleasePrepIntervalMinutes(
    payload?.releasePrepIntervalMinutes,
  );
  if (releasePrepIntervalMinutes === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, releasePrepIntervalMinutes },
    update: { releasePrepIntervalMinutes },
  });

  return NextResponse.json({
    releasePrepIntervalMinutes:
      updated.releasePrepIntervalMinutes ?? RELEASE_PREP_INTERVAL_MINUTES_DEFAULT,
  });
}
