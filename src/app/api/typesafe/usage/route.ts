import { NextResponse, type NextRequest } from "next/server";

import { authorizeTypeSafeUsage } from "@/lib/typesafe/usage-auth";
import { getTypeSafeTotalInputTokens, getTypeSafeUsageSummary } from "@/lib/typesafe/usage";

/** ops-dashboardへ、Jevだけの実測呼出回数・入力トークン数を公開する。 */
export async function GET(request: NextRequest) {
  const auth = authorizeTypeSafeUsage(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const totalInputTokens = await getTypeSafeTotalInputTokens();
  const summary = getTypeSafeUsageSummary();
  return NextResponse.json(totalInputTokens === undefined ? summary : { ...summary, totalInputTokens }, {
    headers: { "Cache-Control": "no-store" },
  });
}
