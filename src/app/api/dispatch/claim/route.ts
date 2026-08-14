import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { claimDispatchJobs } from "@/lib/dispatch/jobs";

/**
 * サブPCのpollerがジョブを取りに来る口（#1179）。
 *
 * **払い出す本数は同時実行数の上限に従う**（`AppSetting.dispatchConcurrency`。定数では
 * 埋め込まない。#1176）。ホスト側が`maxConcurrency`を申告していればその小さい方を採る。
 *
 * 認証は共有シークレット`DISPATCH_SECRET`。未設定は503で、値の不一致（401）と区別する
 * （poller側が「設定漏れ」と「値が違う」を切り分けられるようにするため）。
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
  if (!hostName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // pollerが一度に処理できる本数。指定が無ければ1本ずつ取る（上限側は同時実行数が守る）。
  //
  // **`0`は「起動ジョブは要らない」**（#1332 × #1361）。セッションが上限に達したホストは
  // 新しいセッションを立てられないが、**そういうときこそ停止・終了は届かないと困る**ため、
  // 制御ジョブだけを取りに来る。取りに来ないと、届かない操作が5分で失効する
  const requested = payload?.maxJobs;
  const maxJobs =
    typeof requested === "number" && Number.isInteger(requested) && requested >= 0
      ? Math.min(requested, 10)
      : 1;

  const jobs = await claimDispatchJobs({ hostName, maxJobs });
  return NextResponse.json({ ok: true, jobs }, { headers: { "Cache-Control": "no-store" } });
}
