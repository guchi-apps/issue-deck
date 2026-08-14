import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { announceDispatchHost } from "@/lib/dispatch/jobs";

function parsePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * ホストからの申告（#1179）。「自分が実行できるリポジトリの一覧」と生存報告を兼ねる。
 *
 * **ここに実行可能リポジトリを持つのは、ジョブの割り当て可否を決める情報だから**（#1176の
 * コメント）。ホストの死活・CPU・メモリ・tmuxセッション一覧はops-dashboard#34の担当で、
 * issue-deckには持ち込まない。
 *
 * 申告する側（`scripts/subpc-dispatch-poller.sh`）は`local-repos.conf`を走査し、
 * `scripts/start-local-session.sh`と同じ4つの検証を通ったものだけを載せる（検証は
 * `scripts/lib/local-repo-resolve.sh`で共有）。**issue-deck側は検証をやり直さない。**
 * チェックアウトの有無はサブPCにしか分からず、こちらで判定を持つとずれるだけになる。
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
  if (!hostName || !Array.isArray(payload?.repositories)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const host = await announceDispatchHost({
    hostName,
    repositories: payload.repositories,
    contractVersion: parsePositiveInt(payload?.contractVersion),
    maxConcurrency: parsePositiveInt(payload?.maxConcurrency),
    agentVersion:
      typeof payload?.agentVersion === "string" ? payload.agentVersion.slice(0, 191) : null,
  });

  return NextResponse.json({ ok: true, host }, { headers: { "Cache-Control": "no-store" } });
}
