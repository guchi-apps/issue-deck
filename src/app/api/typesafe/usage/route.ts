import { NextResponse, type NextRequest } from "next/server";

import { authorizeTypeSafeUsage } from "@/lib/typesafe/usage-auth";
import { getTypeSafeUsageSummary } from "@/lib/typesafe/usage";

/** ops-dashboardへ、Jevだけの実測呼出回数・入力トークン数を公開する。 */
export function GET(request: NextRequest) {
  const auth = authorizeTypeSafeUsage(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getTypeSafeUsageSummary(), {
    headers: { "Cache-Control": "no-store" },
  });
}
