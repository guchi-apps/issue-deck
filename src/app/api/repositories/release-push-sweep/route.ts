import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runReleasePushSweep } from "@/lib/notifications/release-push";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 新しく出たリリース（本番反映）を巡回し、見つけたらPush通知する（#2725）。
 *
 * **これまでリリース通知はSignalyへのwebhookにしか流れておらず、issue-deckのPWAには
 * 届かなかった。** 詳細は`src/lib/notifications/release-push.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証はディスパッチAPIと
 * 同じ共有シークレット`DISPATCH_SECRET`。**実際に巡回するかどうかはサーバー側が間隔
 * （`RELEASE_PUSH_SWEEP_INTERVAL_MINUTES`・既定5分）で決める**ので、poller側は1巡ごとに
 * 素直に呼んでよい。間隔に達していなければ`swept: false`が返るだけ。
 *
 * `POST /api/dispatch/claim`へ相乗りさせない理由は本番マージ待ちの巡回（#2376）と同じ。
 *
 * リクエストボディは任意。`{"force": true}`で間隔を無視して巡回する（動作確認用）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_push", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const force = payload?.force === true;

  try {
    const result = await runReleasePushSweep({ force });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない**（他の巡回と同じ取り決め）。
    console.error("[POST /api/repositories/release-push-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
