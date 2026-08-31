import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { reportSessionPlanDelivery } from "@/lib/dispatch/plan-requests";

/** 計画の判断を受け取った後、セッション側が処理結果を返す監査用API。 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const id = typeof payload?.id === "string" ? payload.id : null;
  const status = payload?.status;
  const exitCode = payload?.exitCode;
  if (
    !id ||
    !["PROCESSED", "PROCESS_FAILED", "COMMUNICATION_FAILED"].includes(status) ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await reportSessionPlanDelivery({
    id,
    status,
    exitCode,
    summary: typeof payload?.summary === "string" ? payload.summary : null,
  });
  if (!updated) return NextResponse.json({ error: "not_found_or_already_reported" }, { status: 404 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
