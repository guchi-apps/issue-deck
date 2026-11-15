import { NextResponse, type NextRequest } from "next/server";

import { fileCrossRepoIssues, parseCrossRepoIssueRequests } from "@/lib/dispatch/cross-repo-filing";
import { defaultCrossRepoDeps } from "@/lib/dispatch/cross-repo-filing-deps";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 実装セッションが「他リポジトリにも修正が要る」と判断したときの受け口（#5421）。
 *
 * 送るのは`scripts/report-cross-repo-issue.sh`（Claude Code・Codex共通）。起票先へ子Issueを作り、
 * 起点IssueのサブIssueへ紐付け、起点と同じホスト・エージェントで子の実装セッションを起動する。
 * 起票・紐付けの失敗は500、起動の失敗は結果に載せて200で返す（起票は済んでいて、人が画面から
 * 起動し直せるため）。認証は`/dispatch/sessions/*`と同じ共有シークレット（`DISPATCH_SECRET`）。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  if (!target) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const origin = { repository: target.repositoryFullName, issueNumber: target.issueNumber };
  const parsed = parseCrossRepoIssueRequests(payload?.requests, origin);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!(await defaultCrossRepoDeps.isRegistered(origin.repository))) {
    return NextResponse.json({ error: `${origin.repository}はissue-deckへ登録されていません` }, { status: 400 });
  }

  try {
    const results = await fileCrossRepoIssues(parsed.requests, origin, defaultCrossRepoDeps);
    return NextResponse.json({ ok: true, results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/cross-repo-issues]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "filing_failed" }, { status: 500 });
  }
}
