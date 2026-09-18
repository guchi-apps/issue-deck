import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { resumeAgentSessions } from "@/lib/dispatch/agent-resume-run";
import { parseDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * エージェント別の「再開」を1回で行う入口（#3045）。新規実行のブロックを解除し、一括停止で
 * 止まっているセッションへ固定の1行を積む。
 *
 * **押すのは人。** 受け取るのは`agent`だけで、送る本文は`agent-resume.ts`の固定の1行に限る
 * （呼び出し側は本文を指定できない）。対象のセッションは**サーバー側が記録から選び直す**——
 * 画面の言い分（どのセッションを再開するか）を信じない。送出は既存の追加指示（#1012）の
 * `INSTRUCTION`ジョブで、3段階プロトコルと「承認プロンプト・選択フォームの表示中は送らない」
 * 歯止めがそのまま効く（`docs/multi-agent/gates.md`の例外2の内側）。
 *
 * ブロックの解除だけを行う`POST /api/dispatch/agent-pause`とは分けてある。あちらは
 * トグルだけをONにする操作で、セッションへは何も送らない。
 *
 * 認証はSupabaseのログインセッション（`agent-pause`と同じ）。
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
  if (!agent) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await resumeAgentSessions({ agent, userId });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
