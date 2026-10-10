import { NextResponse, type NextRequest } from "next/server";

import { authorizeVpsMemoryRead } from "@/lib/vps-memory/auth";
import { loadReport } from "@/lib/vps-memory/store";

/**
 * AIDE向けのVPSメモリ計測結果（#4256）。最新・最後に取得できた時刻・プロセス区間ごとの要約を返す読み取り専用API。
 * `?history=1`で採取サンプルも返す。`?hours=`は1〜168（既定24）。取得不可は`latest.status`・`reason`で返し、0に置き換えない。
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeVpsMemoryRead(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth !== "ok") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const hoursRaw = params.get("hours");
  const hours = hoursRaw === null ? 24 : Number(hoursRaw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) return NextResponse.json({ error: "invalid_hours" }, { status: 400 });

  try {
    const report = await loadReport({ hours, includeSamples: params.get("history") === "1" });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[GET /api/integrations/vps-memory]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
