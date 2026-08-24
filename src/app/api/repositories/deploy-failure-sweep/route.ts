import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runDeployFailureSweep } from "@/lib/github/deploy-failure-sweep-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 本番デプロイが失敗したまま止まっているリポジトリを巡回し、追跡用のIssueを起票する（#2236）。
 *
 * **失敗はいままで通知1件と赤いバッジにしか残らなかった。** `deploy-retry.yml`の自動再実行
 * （#2134）で直らない失敗は、人が気づいて「本番へ再デプロイ」を押すまで本番が古い版のまま残る。
 * 詳細は`src/lib/deploy-failure.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証はディスパッチAPIと
 * 同じ共有シークレット`DISPATCH_SECRET`。**実際に巡回するかどうかはサーバー側が間隔
 * （`DEPLOY_FAILURE_SWEEP_INTERVAL_MINUTES`・既定5分）で決める**ので、poller側は1巡ごとに
 * 素直に呼んでよい。間隔に達していなければ`swept: false`が返るだけ。
 *
 * リクエストボディは任意。`{"force": true}`で間隔を無視して巡回する（動作確認用）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("deploy_failure_sweep", () => handlePOST(request));
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
    const result = await runDeployFailureSweep({ force });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない**（コンフリクト巡回と同じ取り決め）。
    console.error("[POST /api/repositories/deploy-failure-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
