import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseSessionUsagePayload, storeSessionUsage } from "@/lib/dispatch/session-usage";

/**
 * ローカルセッションのトークン使用量の報告（#2504）。
 *
 * 報告するのはサブPCの`scripts/subpc-dispatch-poller.sh`（`report_session_usage`）。
 * **本番のissue-deck（VPS）は転記を読めない**ため、集計はホスト側で行い、ここへは数値と
 * 分類だけが届く。
 *
 * **`/sessions`と違って全件置換ではない。** あちらは「今見えているセッションの全て」で、
 * 含まれない行は消えたものとみなすが、こちらは過去ぶんを溜めていく表で、pollerは直近数日の
 * 転記しか開かない。送られてきた行を上書きするだけにしてある。
 *
 * **壊れた行は捨てて残りを受け入れる**（`parseSessionUsagePayload`）。転記の形はClaude Codeの
 * 内部仕様なので、想定外が1件混ざっただけで報告全体を落とすと、その日の数字が丸ごと欠ける。
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
  const hostName = parseDispatchHostName((payload as { host?: unknown } | null)?.host);
  const parsed = parseSessionUsagePayload(payload);
  if (!hostName || !parsed) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await storeSessionUsage({
    hostName,
    reportedAt: parsed.reportedAt,
    sessions: parsed.sessions,
  });

  return NextResponse.json(
    { ok: true, stored: result.stored, skipped: parsed.skipped, deleted: result.deleted },
    { headers: { "Cache-Control": "no-store" } },
  );
}
