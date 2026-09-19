import { NextResponse, type NextRequest } from "next/server";

import {
  CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT,
  CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT,
  NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT,
  NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
  NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
  parseClaudeWindowKeepAliveHour,
  parseNextWindowRunFloorPercent,
  parseNextWindowRunIntervalMinutes,
  parseNextWindowRunLeadMinutes,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { ScheduledRunSettings } from "@/lib/nightly-run";
import { readClaudeWindowKeepAliveSettings } from "@/lib/claude-window-keepalive-run";
import { readNextWindowRunSettings } from "@/lib/next-window-run-db";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 予約実行の設定（次枠実行 #2995・5時間枠を開けておく #3032）。
 *
 * **「実行設定」区分の保存ボタンには載せない。** 切り替えた時点で保存し、効くのは次の巡回から
 * （画像の自動削除`PATCH /api/settings/image-cleanup`と同じ性質）。置き場所も設定ダイアログ
 * ではなく「予約実行」画面で、機能と設定を同じ場所に置く。
 *
 * ボディは`{ nextWindow?: {...}, keepAlive?: {...} }`の入れ子で受ける（かつては`nightly`キーも並んでいたが#3019で
 * 削除した。入れ子のまま残すのは、将来また種類が増えたときに平らなキーの衝突を避けるため）。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { enabled, startHour, endHour } = await readClaudeWindowKeepAliveSettings();
  const settings: ScheduledRunSettings = {
    nextWindow: await readNextWindowRunSettings(),
    keepAlive: { enabled, startHour, endHour },
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
  const nextWindow = payload?.nextWindow ?? {};
  const keepAlive = payload?.keepAlive ?? {};

  const parsed = {
    nextEnabled: readOptionalBoolean(nextWindow.enabled),
    leadMinutes: readOptionalNumber(nextWindow.leadMinutes, parseNextWindowRunLeadMinutes),
    intervalMinutes: readOptionalNumber(
      nextWindow.intervalMinutes,
      parseNextWindowRunIntervalMinutes,
    ),
    fiveHourFloorPercent: readOptionalNumber(
      nextWindow.fiveHourFloorPercent,
      parseNextWindowRunFloorPercent,
    ),
    weeklyFloorPercent: readOptionalNumber(
      nextWindow.weeklyFloorPercent,
      parseNextWindowRunFloorPercent,
    ),
    keepAliveEnabled: readOptionalBoolean(keepAlive.enabled),
    keepAliveStartHour: readOptionalNumber(keepAlive.startHour, parseClaudeWindowKeepAliveHour),
    keepAliveEndHour: readOptionalNumber(keepAlive.endHour, parseClaudeWindowKeepAliveHour),
  };
  const values = Object.values(parsed);
  if (values.some((value) => value === INVALID)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (values.every((value) => value === undefined)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const {
    nextEnabled,
    leadMinutes,
    intervalMinutes,
    fiveHourFloorPercent,
    weeklyFloorPercent,
    keepAliveEnabled,
    keepAliveStartHour,
    keepAliveEndHour,
  } = parsed as {
    nextEnabled?: boolean;
    leadMinutes?: number;
    intervalMinutes?: number;
    fiveHourFloorPercent?: number;
    weeklyFloorPercent?: number;
    keepAliveEnabled?: boolean;
    keepAliveStartHour?: number;
    keepAliveEndHour?: number;
  };

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      nextWindowRunEnabled: nextEnabled ?? false,
      nextWindowRunLeadMinutes: leadMinutes ?? NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
      nextWindowRunIntervalMinutes: intervalMinutes ?? NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
      nextWindowRunFiveHourFloorPercent:
        fiveHourFloorPercent ?? NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT,
      nextWindowRunWeeklyFloorPercent: weeklyFloorPercent ?? NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT,
      claudeWindowKeepAliveEnabled: keepAliveEnabled ?? false,
      claudeWindowKeepAliveStartHour:
        keepAliveStartHour ?? CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT,
      claudeWindowKeepAliveEndHour: keepAliveEndHour ?? CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT,
    },
    update: {
      ...(nextEnabled === undefined ? {} : { nextWindowRunEnabled: nextEnabled }),
      ...(leadMinutes === undefined ? {} : { nextWindowRunLeadMinutes: leadMinutes }),
      ...(intervalMinutes === undefined ? {} : { nextWindowRunIntervalMinutes: intervalMinutes }),
      ...(fiveHourFloorPercent === undefined
        ? {}
        : { nextWindowRunFiveHourFloorPercent: fiveHourFloorPercent }),
      ...(weeklyFloorPercent === undefined
        ? {}
        : { nextWindowRunWeeklyFloorPercent: weeklyFloorPercent }),
      ...(keepAliveEnabled === undefined ? {} : { claudeWindowKeepAliveEnabled: keepAliveEnabled }),
      ...(keepAliveStartHour === undefined
        ? {}
        : { claudeWindowKeepAliveStartHour: keepAliveStartHour }),
      ...(keepAliveEndHour === undefined ? {} : { claudeWindowKeepAliveEndHour: keepAliveEndHour }),
    },
  });

  const settings: ScheduledRunSettings = {
    nextWindow: {
      enabled: updated.nextWindowRunEnabled,
      leadMinutes:
        parseNextWindowRunLeadMinutes(updated.nextWindowRunLeadMinutes) ??
        NEXT_WINDOW_RUN_LEAD_MINUTES_DEFAULT,
      intervalMinutes:
        parseNextWindowRunIntervalMinutes(updated.nextWindowRunIntervalMinutes) ??
        NEXT_WINDOW_RUN_INTERVAL_MINUTES_DEFAULT,
      fiveHourFloorPercent:
        parseNextWindowRunFloorPercent(updated.nextWindowRunFiveHourFloorPercent) ??
        NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT,
      weeklyFloorPercent:
        parseNextWindowRunFloorPercent(updated.nextWindowRunWeeklyFloorPercent) ??
        NEXT_WINDOW_RUN_FLOOR_PERCENT_DEFAULT,
    },
    keepAlive: {
      enabled: updated.claudeWindowKeepAliveEnabled,
      startHour:
        parseClaudeWindowKeepAliveHour(updated.claudeWindowKeepAliveStartHour) ??
        CLAUDE_WINDOW_KEEPALIVE_START_HOUR_DEFAULT,
      endHour:
        parseClaudeWindowKeepAliveHour(updated.claudeWindowKeepAliveEndHour) ??
        CLAUDE_WINDOW_KEEPALIVE_END_HOUR_DEFAULT,
    },
  };
  return NextResponse.json(settings);
}
