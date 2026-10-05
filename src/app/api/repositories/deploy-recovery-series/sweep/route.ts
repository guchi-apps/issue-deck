import { NextResponse, type NextRequest } from "next/server";

import { runDeployRecoverySweep } from "@/lib/deploy-recovery-series-run";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * サブPCのpollerが本番復旧系列（#3998）を進めるための内部入口。`host`は呼んだpollerのホスト名で、
 * 修正の実装はそのホストで起動する。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const hostName = typeof payload?.host === "string" ? payload.host : "";
  if (!hostName) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    return NextResponse.json(
      { ok: true, ...(await runDeployRecoverySweep({ hostName })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/repositories/deploy-recovery-series/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
