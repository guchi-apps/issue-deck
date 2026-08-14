import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseDispatchSessionReport } from "@/lib/dispatch/session-state";
import { reportDispatchSessions } from "@/lib/dispatch/sessions";

/**
 * 起動後のtmuxセッションの状態報告（#1217）。
 *
 * `DispatchJob`はtmuxセッションが立った時点で`SUCCEEDED`になって終わるため、**その後の
 * セッションを見ている口が無かった**。ここがその受け口で、報告するのはサブPCの
 * `scripts/subpc-dispatch-poller.sh`。
 *
 * **報告は「そのホストで今見えているセッションの全て」**として扱い、含まれない行は消えたものと
 * みなす。そのためpollerは0本でも空配列を送る。
 *
 * 載るのはIssueに紐づくセッション（`<リポジトリ名>-issue-<番号>`）だけで、ホスト上の無関係な
 * tmuxセッションは送られてこない。ホストの死活・CPU・メモリ・tmuxセッション一覧は
 * ops-dashboard側の担当という既存の切り分け（`../hosts/route.ts`）をここでも守る。
 *
 * 認証は`/claim`・`/report`・`/hosts`と同じ共有シークレット（`DISPATCH_SECRET`）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const hostName = parseDispatchHostName(payload?.host);
  if (!hostName || !Array.isArray(payload?.sessions)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **1件でも壊れていたら全体を拒否する。** 一部だけ受け入れると、落とした分が「報告に
  // 含まれなかった」＝消えたと判定され、生きているセッションがGONEになる。
  const sessions = [];
  for (const item of payload.sessions) {
    const parsed = parseDispatchSessionReport(item);
    if (!parsed) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    sessions.push(parsed);
  }

  const result = await reportDispatchSessions({ hostName, sessions });

  return NextResponse.json(
    { ok: true, sessions: result.sessions, escalated: result.escalated },
    { headers: { "Cache-Control": "no-store" } },
  );
}
