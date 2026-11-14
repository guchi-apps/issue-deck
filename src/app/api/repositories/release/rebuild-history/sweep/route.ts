import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { previewModeGuard } from "@/lib/preview-mode";
import { reconcileAllReleasePreparationFailures } from "@/lib/release-preparation-run";
import { sweepAllCompletedRebuildHistory } from "@/lib/release-rebuild-history-run";

/** 完了した作り直し履歴の掃除の最短間隔（#5382） */
const HISTORY_SWEEP_INTERVAL_MS = 5 * 60_000;
let lastHistorySweepAt = 0;

/**
 * サブPCのpollerが、完了したリリースの作り直し履歴（#4420）を掃除するための内部入口。
 * リリースがmainへマージされ（iOSアプリのあるリポジトリはTestFlight配布も済み）、完了したと判定できた
 * 経過の履歴を削除する。画面を開かないリポジトリの履歴も残さないため、画面の取得ではなく巡回で行う。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const now = Date.now();
    // 完了した履歴の掃除は急がない。pollerの巡回（約30〜50秒）ごとに回すと、iOS配布待ちのリポジトリで
    // マージ済みリリースPRを毎回取り直す（#5382）。間隔を置き、見送った回は件数0で返す
    const history =
      now - lastHistorySweepAt >= HISTORY_SWEEP_INTERVAL_MS
        ? await withGithubApiFeature("rebuild_history_sweep", () => {
            lastHistorySweepAt = now;
            return sweepAllCompletedRebuildHistory();
          })
        : { repositories: 0, deleted: 0, skipped: true };
    // 履歴の有無と無関係に、後続のリリース成功で解消済みの準備失敗を解決へ倒す（#4450）
    const resolvedFailures = await withGithubApiFeature("rebuild_history_sweep", () => reconcileAllReleasePreparationFailures());
    return NextResponse.json(
      { ok: true, ...history, resolvedFailures },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/repositories/release/rebuild-history/sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}
