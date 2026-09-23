import { NextResponse, type NextRequest } from "next/server";

import { RELEASE_PREP_INTERVAL_MINUTES_DEFAULT } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * リリース準備の自動実行間隔を、reusable-release-develop-to-main.ymlのgateへ返す（#3416）。
 * 認証は進捗報告APIと同じ共有シークレット。`intervalMinutes`が0なら自動実行しない。
 */
export async function GET(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return NextResponse.json(
    {
      intervalMinutes:
        setting?.releasePrepIntervalMinutes ?? RELEASE_PREP_INTERVAL_MINUTES_DEFAULT,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
