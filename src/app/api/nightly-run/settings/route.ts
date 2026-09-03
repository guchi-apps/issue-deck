import { NextResponse, type NextRequest } from "next/server";

import { NIGHTLY_RUN_START_HOUR_DEFAULT, parseNightlyRunStartHour } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { NightlyRunSettings } from "@/lib/nightly-run";
import { readNightlyRunSettings } from "@/lib/nightly-run-db";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 夜間実行（#2772）の設定。有効／無効と開始時刻。
 *
 * **「実行設定」区分の保存ボタンには載せない。** 切り替えた時点で保存し、効くのは次の巡回から
 * （画像の自動削除`PATCH /api/settings/image-cleanup`と同じ性質）。置き場所も設定ダイアログ
 * ではなく「夜間実行」画面の右上で、機能と設定を同じ場所に置く。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const settings = await readNightlyRunSettings();
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const enabled = payload?.enabled === undefined ? null : payload.enabled;
  if (enabled !== null && typeof enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const startHour =
    payload?.startHour === undefined ? null : parseNightlyRunStartHour(payload.startHour);
  if (payload?.startHour !== undefined && startHour === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (enabled === null && startHour === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      nightlyRunEnabled: enabled ?? false,
      nightlyRunStartHour: startHour ?? NIGHTLY_RUN_START_HOUR_DEFAULT,
    },
    update: {
      ...(enabled === null ? {} : { nightlyRunEnabled: enabled }),
      ...(startHour === null ? {} : { nightlyRunStartHour: startHour }),
    },
  });

  const settings: NightlyRunSettings = {
    enabled: updated.nightlyRunEnabled,
    startHour: parseNightlyRunStartHour(updated.nightlyRunStartHour) ?? NIGHTLY_RUN_START_HOUR_DEFAULT,
  };
  return NextResponse.json(settings);
}
