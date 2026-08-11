import { NextResponse, type NextRequest } from "next/server";

import { withGithubApiFeature } from "@/lib/github/api-usage";
import { reportProgressStatus } from "@/lib/github/report-progress";
import { parseProgressStatusKey } from "@/lib/issue-progress";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * 進捗報告API（#991 Phase 2）。
 *
 * **実行基盤に依存しない状態管理インターフェースの実体。** GitHub Actions・ミニPC上の
 * Claude Code・VS Code・Claudeアプリのどこから実装しても、ここへ報告すればカンバンが追従する。
 * Projects v2への書き込み権限を持つのはissue-deckのGitHub Appだけで、呼び出し側には配らない
 * （設計は docs/progress-status-architecture.md）。
 *
 * 認証はログインセッションではなく共有シークレット（`PROGRESS_REPORT_SECRET`）。
 * 呼び出し側は無人実行でセッションを持てないため。
 *
 * リクエスト: `{ "repository": "owner/name", "issue": 123, "status": "implementation" }`
 * `status`は`ProgressStatusKey`（src/lib/issue-progress.ts）で、ラベル名やStatus名ではない。
 * ラベルを廃止するPhase 5でも呼び出し側を書き換えずに済ませるため。
 *
 * **呼び出し側はこのAPIの失敗でワークフローを止めない。** issue-deckが単一障害点になるのを
 * 避けるための取り決めで、ズレは再同期（`POST /api/sync/issues`）で是正できるようにしてある。
 */
export function POST(request: NextRequest) {
  return withGithubApiFeature("progress_report", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
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
  const issueNumber =
    Number.isInteger(payload?.issue) && payload.issue > 0 ? (payload.issue as number) : null;
  const status = parseProgressStatusKey(payload?.status);

  if (!repositoryFullName || issueNumber === null || !status) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await reportProgressStatus({ repositoryFullName, issueNumber, status });

  // 反映されなかったケース（Project未導入・Projectに未登録・既に同じStatus）も、
  // 呼び出し側にとっては「エラーではない」ため200で返し、理由だけを伝える
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
