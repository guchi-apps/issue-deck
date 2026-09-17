import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { parseDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { setAgentDispatchPause } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * エージェット別の新規実行の一時停止を、人が手動で切り替える入口（#2994）。
 *
 * **押すのは人。** ここは`AppSetting`の一時停止理由（`manual`）を書き換えるだけで、
 * 動いているセッションへは何も送らない（`send-keys`を持たない。`sessions/answer-mode`と
 * 同じ形）。動いているセッションへ中断を送るのは、画面側が同じ操作の一部として
 * 個別の`INTERRUPT`（#1332・既存の`POST /api/dispatch`）を対象セッションぶん呼ぶ。
 *
 * ONにする（`paused: false`）ときは、自動検知（`usage_limit`）で止まっていた場合も
 * 含めて必ず解除する。以後の自動判定（`sweepAgentUsageLimitPause`）は、人が再びOFFに
 * するまで`manual`を上書きしない。
 *
 * 認証はSupabaseのログインセッション（`/api/dispatch/sessions/answer-mode`と同じ）。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const agent = parseDispatchAgent(payload?.agent);
  const paused = payload?.paused;
  if (!agent || typeof paused !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const agentPause = await setAgentDispatchPause({ agent, paused });
  return NextResponse.json({ ok: true, agentPause }, { headers: { "Cache-Control": "no-store" } });
}
