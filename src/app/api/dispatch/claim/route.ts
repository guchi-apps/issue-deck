import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { claimDispatchJobs } from "@/lib/dispatch/jobs";
import { sweepCheckUserPushNotifications } from "@/lib/notifications/check-user-push";
import {
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CODEX_MODEL_DEFAULT,
  parseClaudeModel,
  parseCodexModel,
} from "@/lib/app-settings";
import { db } from "@/lib/db";

/**
 * サブPCのpollerがジョブを取りに来る口（#1179）。
 *
 * **払い出す本数は同時実行数の上限に従う**（`AppSetting.dispatchConcurrency`。定数では
 * 埋め込まない。#1176）。ホスト側が`maxConcurrency`を申告していればその小さい方を採る。
 *
 * 認証は共有シークレット`DISPATCH_SECRET`。未設定は503で、値の不一致（401）と区別する
 * （poller側が「設定漏れ」と「値が違う」を切り分けられるようにするため）。
 *
 * **`fast: true`は「重い巡回の合間に枠外ジョブだけ取りに来た」の合図**（#2413）。払い出しは
 * 変わらず、ここに相乗りしている定期処理だけを省く。
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

  // **軽い巡回（#2413）は`fast: true`を名乗る。** pollerは重い巡回の合間に数秒間隔で
  // 枠外のジョブ（手作業の代行実行・停止・追加指示）だけを取りに来る。相乗りしている定期処理を
  // そのまま回すと、30秒に1回の前提で置いたものが10倍走る。**払い出しそのものは同じ**で、
  // 変わるのは相乗りを省くかどうかだけ。古いpollerはこのキーを送らないため、従来どおり回る。
  const fast = payload?.fast === true;

  // 確認待ちのPush通知（#838）を、この取りに来るついでに1歩進める。
  // **常駐プロセスは置かない**（`runManualStepVerificationPatrol`と同じ方針）。ここを選ぶのは
  // pollerが30秒ごとに叩き、**ブラウザを開いていなくても回る**唯一の定期経路だから
  // （画面のポーリングに載せると、アプリを閉じているときのための通知が閉じている間だけ止まる）。
  // **失敗してもジョブの払い出しは続ける。**
  if (!fast) {
    try {
      await sweepCheckUserPushNotifications();
    } catch (error) {
      console.error("[POST /api/dispatch/claim] 確認待ちのPush通知を送れませんでした:", error);
    }
  }

  const jobs = await claimDispatchJobs({ hostName, maxJobs });
  if (jobs.length === 0) {
    return NextResponse.json({ ok: true, jobs }, { headers: { "Cache-Control": "no-store" } });
  }
  const setting = (await db.appSetting.findUnique({ where: { id: 1 } })) as
    | { claudeLocalModel?: string; codexModel?: string }
    | null;
  const claudeLocalModel =
    parseClaudeModel(setting?.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT;
  const codexModel = parseCodexModel(setting?.codexModel) ?? CODEX_MODEL_DEFAULT;
  return NextResponse.json(
    { ok: true, jobs: jobs.map((job) => ({ ...job, claudeLocalModel, codexModel })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
