import { NextResponse, type NextRequest } from "next/server";

import { runDeployRecoverySweep } from "@/lib/deploy-recovery-series-run";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { previewModeGuard } from "@/lib/preview-mode";
import { runReleaseCompletionSweep } from "@/lib/release-completion-run";

/**
 * サブPCのpollerが本番復旧系列（#3998）を進めるための内部入口。`host`は呼んだpollerのホスト名で、
 * 修正の実装はそのホストで起動する。
 *
 * リリース完了系列（#4480）の巡回もここに相乗りする（修正Issueの起動に`host`が要るため。pollerは変更しない）。
 * 世代の進行（作り直し・再検証）は従来どおり`release/fix-series/sweep`が持つ。
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
    const recovery = await runDeployRecoverySweep({ hostName });
    // 片方の障害で他方を止めない
    const completion = await runReleaseCompletionSweep({ hostName }).catch((error: unknown) => {
      console.error("[POST /api/repositories/deploy-recovery-series/sweep] release completion", error);
      return null;
    });
    return NextResponse.json(
      { ok: true, ...recovery, releaseCompletion: completion },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/repositories/deploy-recovery-series/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
