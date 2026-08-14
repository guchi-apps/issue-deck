import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseDispatchSessionName } from "@/lib/dispatch/session-state";
import { markDispatchSessionEnded } from "@/lib/dispatch/sessions";

/**
 * 実装セッションが畳まれた瞬間の報告（#1321）。
 *
 * 送るのは`scripts/run-issue-session.sh`の`cleanup`で、`trap ... EXIT HUP TERM`から1件だけ叩く。
 * 目的は**画面の反映を待たせないこと**に尽きる。#1311で生きているセッションのあるIssueは起動を
 * 押せなくしたため、畳んだ直後にpollerの次の巡回（実測で最大75秒）まで押せない時間ができていた。
 *
 * **pollerの一括報告（`../route.ts`）へは流せない。** あちらは「そのホストで今見えている
 * セッションの全て」を前提に、含まれない行を`GONE`へ倒す作りなので、1件だけ流すと他のセッションが
 * 全部消えたことになる（`../activity/route.ts`にも同じ注意がある）。
 *
 * **pollerの報告を置き換えるものでもない。** SIGKILL・ホストの再起動ではtrapを通らないため、
 * 「報告に含まれない＝消えた」で拾う層は引き続き要る（#1217の設計どおり多層のまま）。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
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
  const tmuxSessionName = parseDispatchSessionName(payload?.tmuxSessionName);
  if (!hostName || !tmuxSessionName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await markDispatchSessionEnded({ hostName, tmuxSessionName });

  // 対象の行が無い（pollerがまだ1巡していない・既に倒れている）場合も200で返す。呼び出し側は
  // セッションの終了処理の最中で、再送の判断をさせる相手ではない。取りこぼしても次の巡回で載る
  return NextResponse.json(
    { ok: true, updated: result.updated },
    { headers: { "Cache-Control": "no-store" } },
  );
}
