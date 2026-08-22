import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runConflictSweep } from "@/lib/github/conflict-sweep-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * コンフリクトしたPRを巡回して見つけ、コンフリクト解消ワークフローを起動する（#2116）。
 *
 * **GitHub Actions側の自動検知は取りこぼす。** `pull_request(opened)`のイベントが配送されない
 * ことがあり、安全網の`schedule`（15分間隔の指定）も実測では24〜36分間隔でしか走らない。その結果
 * 「作った時点で既にコンフリクトしているPR」が誰にも拾われないまま残る（guchi-apps/myroom#191）。
 * 詳細は`src/lib/github/conflict-sweep.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証は
 * ディスパッチAPIと同じ共有シークレット`DISPATCH_SECRET`。**実際に巡回するかどうかは
 * サーバー側が間隔（`CONFLICT_SWEEP_INTERVAL_MINUTES`・既定5分）で決める**ので、
 * poller側は1巡ごとに素直に呼んでよい。間隔に達していなければ`swept: false`が返るだけ。
 *
 * リクエストボディは任意。`{"force": true}`で間隔を無視して巡回する（動作確認用）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("conflict_sweep", () => handlePOST(request));
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
    const result = await runConflictSweep({ force });
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // **巡回の失敗でpollerを止めない。** 500を返してもpollerは次の巡で呼び直すだけで、
    // ジョブの取得には影響しない（呼び出し側で失敗を握り潰す取り決め）。
    console.error("[POST /api/pull-requests/conflict-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
