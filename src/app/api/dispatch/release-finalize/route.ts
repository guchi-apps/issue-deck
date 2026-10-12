import { NextResponse, type NextRequest } from "next/server";

import { withGithubApiFeature } from "@/lib/github/api-usage";
import { authorizeProgressReport } from "@/lib/progress-report-auth";
import { recordFinalizeReport } from "@/lib/release-finalize-run";

/**
 * 公開準備（正式バンプ。#4496）の結果の報告。`reusable-release-develop-to-main.yml`の`finalize`ジョブが呼ぶ。
 *
 * 認証は`POST /api/progress`と同じ共有シークレット。**受け取るのは要求キー・結果の種別・run番号・短い理由だけ**で、
 * バンプが適用されたか（候補ブランチのhead・早送りか・版ファイルの版・差分）はサーバーがGitHubから取り直して決める
 * （`recordFinalizeReport`）。同じ報告の再送・遅れて届いた報告は状態を戻さない。
 *
 * リクエスト: `{ "repository": "owner/name", "requestKey": "…", "outcome": "applied|failed", "runId"?: 123, "reason"?: "…" }`
 */
export function POST(request: NextRequest) {
  return withGithubApiFeature("release_status", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const repositoryFullName =
    typeof payload?.repository === "string" && /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(payload.repository)
      ? (payload.repository as string)
      : null;
  const requestKey = typeof payload?.requestKey === "string" && /^[A-Za-z0-9_:-]{8,64}$/.test(payload.requestKey) ? payload.requestKey : null;
  const outcome = payload?.outcome === "applied" || payload?.outcome === "failed" ? (payload.outcome as "applied" | "failed") : null;
  const runId = Number(payload?.runId);
  if (!repositoryFullName || !requestKey || !outcome) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const result = await recordFinalizeReport({
      repositoryFullName,
      requestKey,
      outcome,
      runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
      reason: typeof payload?.reason === "string" ? payload.reason.slice(0, 1000) : null,
    });
    // 記録できなかった理由（未接続・不明な要求）もworkflowにとってはエラーではないので200で返す
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/release-finalize]", error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
