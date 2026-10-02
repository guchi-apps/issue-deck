import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runIosDistributionFailureSweep } from "@/lib/github/ios-distribution-failure-sweep-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * iOS配布（`ios-testflight.yml`）が失敗したまま止まっているリポジトリを巡回し、追跡用のIssueを
 * 起票する（#3745）。Webの本番デプロイ失敗の巡回（`deploy-failure-sweep`）と同じ形で、
 * 詳細は`src/lib/ios-distribution-failure.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpollerで、認証は`DISPATCH_SECRET`。実際に巡回するかどうかはサーバー側が
 * 間隔（`IOS_DISTRIBUTION_FAILURE_SWEEP_INTERVAL_MINUTES`・既定5分）で決める。
 * `{"force": true}`で間隔を無視して巡回する（動作確認用）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("ios_distribution_failure_sweep", () => handlePOST(request));
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
    const result = await runIosDistributionFailureSweep({ force });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない**（コンフリクト巡回と同じ取り決め）。
    console.error("[POST /api/repositories/ios-distribution-failure-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
