import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runImageCleanupSweep } from "@/lib/images/image-cleanup-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 添付画像の参照を集め直し、使われていない画像を後始末する巡回（#2475）。
 *
 * 呼ぶのはサブPCのpoller（`scripts/subpc-dispatch-poller.sh`）で、認証はディスパッチAPIと
 * 同じ共有シークレット`DISPATCH_SECRET`。**実際に巡回するかどうかはサーバー側が間隔
 * （`IMAGE_CLEANUP_SWEEP_INTERVAL_MINUTES`・既定60分・0で無効）で決める**ので、poller側は
 * 1巡ごとに素直に呼んでよい。間隔に達していなければ`swept: false`が返るだけ。
 *
 * **既存の巡回3本より間隔が長い。** ここが消費するのはIssueコメントの一覧で、初回の
 * バックログを読み切るまではリポジトリあたり最大10ページ（＝1,000件）を取る。
 * 5分ごとに走らせるとインストールトークンの共有枠（5,000 req/時）を圧迫する。
 *
 * リクエストボディは任意。`{"force": true}`で間隔を無視し、`{"full": true}`で
 * コメントのカーソルを捨てて全再スキャンする（削除されたコメントの参照が溜まったときの作り直し）。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("image_cleanup_sweep", () => handlePOST(request));
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
  const full = payload?.full === true;

  try {
    const result = await runImageCleanupSweep({ force, full });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // **巡回の失敗でpollerを止めない。** 500を返してもpollerは次の巡で呼び直すだけ。
    console.error("[POST /api/issues/images/cleanup-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
