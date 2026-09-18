import { NextResponse, type NextRequest } from "next/server";

import {
  NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
  NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
  NIGHTLY_RUN_START_HOUR_DEFAULT,
  parseNextWindowRunIntervalMinutes,
  parseNextWindowRunLeadMinutes,
  parseNightlyRunStartHour,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { ScheduledRunSettings } from "@/lib/nightly-run";
import { readNightlyRunSettings } from "@/lib/nightly-run-db";
import { readNextWindowRunSettings } from "@/lib/next-window-run-db";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 予約実行の設定（夜間実行 #2772・次枠実行 #2995）。
 *
 * **「実行設定」区分の保存ボタンには載せない。** 切り替えた時点で保存し、効くのは次の巡回から
 * （画像の自動削除`PATCH /api/settings/image-cleanup`と同じ性質）。置き場所も設定ダイアログ
 * ではなく「予約実行」画面で、機能と設定を同じ場所に置く。
 *
 * ボディは`{ nightly?: {...}, nextWindow?: {...} }`の入れ子で受ける。**平らなキーにしない**——
 * 2種類の予定に同じ名前の値（`enabled`）があり、平らにすると片方の綴りを間違えても
 * もう片方が黙って書き換わる。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const settings: ScheduledRunSettings = {
    nightly: await readNightlyRunSettings(),
    nextWindow: await readNextWindowRunSettings(),
  };
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
}

/** `undefined`＝変更しない／`INVALID`＝不正な値（400で断る） */
const INVALID = Symbol("invalid");
type Parsed<T> = T | typeof INVALID | undefined;

function readOptionalBoolean(value: unknown): Parsed<boolean> {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : INVALID;
}

/** `parse*`は不正値をnullで返すので、この層の語（`INVALID`）へ揃える */
function readOptionalNumber(value: unknown, parse: (raw: unknown) => number | null): Parsed<number> {
  if (value === undefined) return undefined;
  return parse(value) ?? INVALID;
}

export async function PATCH(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const nightly = payload?.nightly ?? {};
  const nextWindow = payload?.nextWindow ?? {};

  const parsed = {
    enabled: readOptionalBoolean(nightly.enabled),
    startHour: readOptionalNumber(nightly.startHour, parseNightlyRunStartHour),
    nextEnabled: readOptionalBoolean(nextWindow.enabled),
    leadMinutes: readOptionalNumber(nextWindow.leadMinutes, parseNextWindowRunLeadMinutes),
    intervalMinutes: readOptionalNumber(
      nextWindow.intervalMinutes,
      parseNextWindowRunIntervalMinutes,
    ),
  };
  const values = Object.values(parsed);
  if (values.some((value) => value === INVALID)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (values.every((value) => value === undefined)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { enabled, startHour, nextEnabled, leadMinutes, intervalMinutes } = parsed as {
    enabled?: boolean;
    startHour?: number;
    nextEnabled?: boolean;
    leadMinutes?: number;
    intervalMinutes?: number;
  };

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      nightlyRunEnabled: enabled ?? false,
      nightlyRunStartHour: startHour ?? NIGHTLY_RUN_START_HOUR_DEFAULT,
      nextWindowRunEnabled: nextEnabled ?? false,
      nextWindowRunLeadMinutes: leadMinutes ?? NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
      nextWindowRunIntervalMinutes: intervalMinutes ?? NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
    },
    update: {
      ...(enabled === undefined ? {} : { nightlyRunEnabled: enabled }),
      ...(startHour === undefined ? {} : { nightlyRunStartHour: startHour }),
      ...(nextEnabled === undefined ? {} : { nextWindowRunEnabled: nextEnabled }),
      ...(leadMinutes === undefined ? {} : { nextWindowRunLeadMinutes: leadMinutes }),
      ...(intervalMinutes === undefined ? {} : { nextWindowRunIntervalMinutes: intervalMinutes }),
    },
  });

  const settings: ScheduledRunSettings = {
    nightly: {
      enabled: updated.nightlyRunEnabled,
      startHour:
        parseNightlyRunStartHour(updated.nightlyRunStartHour) ?? NIGHTLY_RUN_START_HOUR_DEFAULT,
    },
    nextWindow: {
      enabled: updated.nextWindowRunEnabled,
      leadMinutes:
        parseNextWindowRunLeadMinutes(updated.nextWindowRunLeadMinutes) ??
        NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
      intervalMinutes:
        parseNextWindowRunIntervalMinutes(updated.nextWindowRunIntervalMinutes) ??
        NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
    },
  };
  return NextResponse.json(settings);
}
