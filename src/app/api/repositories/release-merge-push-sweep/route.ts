import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runReleaseMergePushSweep } from "@/lib/notifications/release-merge-push";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 本番へのマージ待ち（develop→mainのリリースPR）を巡回し、見つけたらPush通知する（#2376）。
 *
 * **これまでマージ待ちは通知ベルと画面のバッジにしか出ず、ブラウザを開くまで見えなかった。**
 * #2230では止まったリリースが18時間放置され、そのあいだ本番デプロイが止まっていた。
 * 詳細は`src/lib/notifications/release-merge-push.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証はディスパッチAPIと
 * 同じ共有シークレット`DISPATCH_SECRET`。**実際に巡回するかどうかはサーバー側が間隔
 * （`RELEASE_MERGE_PUSH_SWEEP_INTERVAL_MINUTES`・既定10分）で決める**ので、poller側は
 * 1巡ごとに素直に呼んでよい。間隔に達していなければ`swept: false`が返るだけ。
 *
 * **`POST /api/dispatch/claim`へは相乗りさせない。** あちらはジョブの払い出しで、
 * poller側は`--max-time 30`の中で待ち、失敗するとその巡はジョブを1本も取りに行かない。
 * GitHub APIを叩く巡回をそこへ入れると、通知の遅さがそのまま実装セッションの起動の
 * 遅さになる。既存の3本（コンフリクト・デプロイ失敗・進捗）と同じ形で分けてある。
 *
 * リクエストボディは任意。`{"force": true}`で間隔を無視して巡回する（動作確認用）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_merge_push", () => handlePOST(request));
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
    const result = await runReleaseMergePushSweep({ force });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない**（コンフリクト巡回・デプロイ失敗巡回と同じ取り決め）。
    console.error("[POST /api/repositories/release-merge-push-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
