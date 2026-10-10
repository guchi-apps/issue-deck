import { NextResponse, type NextRequest } from "next/server";

import { withGithubApiFeature } from "@/lib/github/api-usage";
import { authorizeProgressReport } from "@/lib/progress-report-auth";
import { recordReleasePreparationFailure, resolveReleasePreparation } from "@/lib/release-preparation-run";

/**
 * リリース準備の失敗・進行の報告（#4335）。`reusable-release-develop-to-main.yml`の
 * `notify-failure`（`action=failed`）と`notify-prepared`（`action=prepared`）が呼ぶ。
 *
 * 認証は`POST /api/progress`と同じ共有シークレット。**受け取るのはリポジトリとrun番号だけ**で、
 * 失敗した工程・エラー行・成否はサーバーがGitHubから取り直す（`release-preparation-run.ts`）。
 *
 * リクエスト: `{ "action": "failed|prepared", "repository": "owner/name", "runId": 123, "event"?: "workflow_dispatch", "bumpKind"?: "minor" }`
 */
export function POST(request: NextRequest) {
  return withGithubApiFeature("release_status", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const action = payload?.action === "failed" || payload?.action === "prepared" ? (payload.action as string) : null;
  const repositoryFullName =
    typeof payload?.repository === "string" && /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(payload.repository)
      ? (payload.repository as string)
      : null;
  const runId = Number(payload?.runId);
  if (!action || !repositoryFullName || !Number.isSafeInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result =
      action === "failed"
        ? await recordReleasePreparationFailure({
            repositoryFullName,
            runId,
            event: typeof payload?.event === "string" ? payload.event : null,
            bumpKind: typeof payload?.bumpKind === "string" ? payload.bumpKind : null,
          })
        : await resolveReleasePreparation({ repositoryFullName, runId });
    // 記録できなかった理由（未接続・対象外）もworkflowにとってはエラーではないので200で返す
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/release-preparation]", error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
