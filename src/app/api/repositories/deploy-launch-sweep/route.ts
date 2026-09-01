import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runDeployLaunchSweep } from "@/lib/github/deploy-launch-sweep-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * mainへマージしたのに本番デプロイ（`deploy.yml`）が起動していないものを見つけ、
 * `main`から起動し直す（#2703）。
 *
 * **GitHubがマージのイベントを配送し損ねると、ワークフローの定義が正しくても実行が
 * 1件も作られない。** `guchi-apps/myroom`のv4.8.0では本番が20分間古い版のまま残った
 * （myroom#315。実測でmainへのマージ55件中1件）。詳細は
 * `src/lib/deploy-launch.ts`のヘッダーコメントを参照。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証はディスパッチAPIと
 * 同じ共有シークレット`DISPATCH_SECRET`。**他の巡回と違って間隔で間引かない**——遅れが
 * そのまま本番が古いままの時間になるため、pollerの1巡（30秒）ごとにそのまま走らせる。
 * 見張っている行が1つも無ければGitHubを1回も叩かない。
 *
 * リクエストボディは不要。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("deploy_launch_sweep", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDeployLaunchSweep();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない**（他の巡回と同じ取り決め）。
    console.error("[POST /api/repositories/deploy-launch-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
