import { NextResponse, type NextRequest } from "next/server";

import { withGithubApiFeature } from "@/lib/github/api-usage";
import {
  queryIssueProgressStatus,
  queryIssuesByProgressStatus,
} from "@/lib/github/query-progress";
import { reportProgressStatus } from "@/lib/github/report-progress";
import { parseProgressStatusKey, type ProgressStatusKey } from "@/lib/issue-progress";
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

/**
 * 進捗の問い合わせ（#991 Phase 5・#1010）。**進捗ラベルを廃止したことで、ワークフローが
 * 「いま何がどの段階にあるか」をGitHubのラベルから知る手段が無くなった**ため、その代わりの入口。
 *
 * 2つの形を受ける。認証はPOSTと同じ共有シークレット。
 *
 * - `?repository=owner/name&issue=123` → `{ status: "implementation" | null }`
 *   1件の現在の進捗。`reusable-issue-dispatch.yml`の実行モード判定が使う
 * - `?repository=owner/name&status=develop,release` → `{ issues: [12, 34] }`
 *   その進捗にあるopenなIssueの番号。develop→mainのリリース関連ジョブと
 *   `develop-merge-sweep`が、以前`gh issue list --label`で探していた部分に使う
 *
 * **答えられない場合も200で理由を返す。** 呼び出し側はこのAPIの失敗でワークフローを
 * 止めない取り決め（docs/progress-status-architecture.md）で、`available: false`は
 * エラーではなく「判断材料が無い」を意味する。ただし**Phase 5以降、判断材料が無い状態は
 * ラベルで代替できない。** 一覧を返せなければリリース時の一括遷移はその回スキップされ、
 * 再実行するまで反映されない。
 */
export function GET(request: NextRequest) {
  return withGithubApiFeature("progress_report", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const repositoryFullName = params.get("repository");
  if (!repositoryFullName?.includes("/")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issueParam = params.get("issue");
  const statusParam = params.get("status");
  const noStore = { headers: { "Cache-Control": "no-store" } };

  if (issueParam !== null) {
    const issueNumber = Number(issueParam);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = await queryIssueProgressStatus({ repositoryFullName, issueNumber });
    return NextResponse.json({ ok: true, ...result }, noStore);
  }

  if (statusParam !== null) {
    const statuses: ProgressStatusKey[] = [];
    for (const value of statusParam.split(",")) {
      const status = parseProgressStatusKey(value.trim());
      if (!status) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      statuses.push(status);
    }
    if (statuses.length === 0) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = await queryIssuesByProgressStatus({ repositoryFullName, statuses });
    return NextResponse.json({ ok: true, ...result }, noStore);
  }

  return NextResponse.json({ error: "invalid_request" }, { status: 400 });
}
