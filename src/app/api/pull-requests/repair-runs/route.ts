import { NextResponse, type NextRequest } from "next/server";

import {
  isRepairKind,
  isRepairRunStatus,
  recordPullRequestRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * PRの自動修復が始まった・終わったことを、修復ワークフローから受け取る（#2072）。
 *
 * 認証はログインセッションではなく共有シークレット（`PROGRESS_REPORT_SECRET`）。呼ぶのは
 * `reusable-claude-ci-fix.yml`・`reusable-claude-conflict-resolve.yml`・
 * `reusable-claude-pr-repair.yml`で、セッションを持たないため（`POST /api/progress`と
 * 同じ理由・同じ値を使う）。
 *
 * **走っている側から報告してもらうのは、GitHub APIから引けないから。** 自動検知で起動した
 * 実行は`workflow_run`イベント発のため、runの`head_branch`・`head_sha`が対象PRではなく
 * デフォルトブランチを指し、runから対象PRへ辿る手段が無い。
 *
 * **呼び出し側はこのAPIの失敗でワークフローを止めない**取り決め（`POST /api/progress`と同じ）。
 * 終了の報告が届かなかった場合は`REPAIR_RUN_STALE_MINUTES`で時間切れとして倒す。
 *
 * リクエスト: `{ "repository": "owner/name", "pullRequest": 123, "kind": "ci",
 * "status": "running", "runUrl": "https://..." }`
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);

  const repositoryFullName =
    typeof payload?.repository === "string" && payload.repository.includes("/")
      ? payload.repository
      : null;
  const pullRequestNumber =
    Number.isInteger(payload?.pullRequest) && payload.pullRequest > 0
      ? (payload.pullRequest as number)
      : null;

  if (
    repositoryFullName === null ||
    pullRequestNumber === null ||
    !isRepairKind(payload?.kind) ||
    !isRepairRunStatus(payload?.status)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  await recordPullRequestRepairRun({
    repositoryFullName,
    pullRequestNumber,
    kind: payload.kind,
    status: payload.status,
    runUrl: typeof payload?.runUrl === "string" && payload.runUrl !== "" ? payload.runUrl : null,
  });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
