import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseReviewUsagePayload, storeReviewUsage } from "@/lib/dispatch/review-usage";

/**
 * サブPCで走ったPRレビュー（Codex PRレビュー等）の使用量の報告（#3995）。
 *
 * 報告するのは`scripts/start-codex-pr-review.sh`。数値と対象（リポジトリ・PR・HEAD・試行）だけが
 * 届き、会話の本文は入ってこない。認証は`/session-usage`と同じ共有シークレット（`DISPATCH_SECRET`）。
 * 送り手は`200`を受け取るまで報告を手元に残して送り直すので、壊れた行は数だけ返して捨てる。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const hostName = parseDispatchHostName((payload as { host?: unknown } | null)?.host);
  const parsed = parseReviewUsagePayload(payload);
  if (!hostName || !parsed) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const stored = await storeReviewUsage({ hostName, reports: parsed.reports });
  return NextResponse.json(
    { ok: true, stored, skipped: parsed.skipped },
    { headers: { "Cache-Control": "no-store" } },
  );
}
