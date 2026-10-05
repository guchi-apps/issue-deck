import { NextResponse, type NextRequest } from "next/server";

import { DISPATCH_AGENTS, parseDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { describePrReviewGateState, parsePrReviewSha } from "@/lib/dispatch/pr-review";
import { getPrReviewGate, requestPrReviewJob } from "@/lib/dispatch/pr-review-jobs";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * develop向けPRのAIレビュー（`PR_REVIEW`）の依頼と状態の取得（#3990）。
 *
 * 呼ぶのは`reusable-claude-review-develop.yml`の`codex-review`（依頼）と`auto-merge`（状態の取得）。
 * 認証は`POST /api/progress`と同じ共有シークレット（`PROGRESS_REPORT_SECRET`）。
 *
 * - `action: "request"` … レビューを積む（冪等）。**結果は待たずに返す。** 実行できるサブPCが無ければ
 *   積まずに`409`で理由を返し、Actionsは30分待たずに失敗として扱える
 * - `action: "status"` … 同じPR・HEAD・agentの最新のジョブの状態を返す（積まない）
 *
 * リクエスト: `{ "action": "request", "repository": "owner/name", "pullRequest": 123,
 * "headSha": "…", "baseSha": "…", "agent": "codex", "runId": "123456" }`
 * レスポンス: `{ "state": "missing|pending|done|failed|stale", "verdict"?, "reason"?, "message" }`
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const action = payload?.action === "status" ? "status" : payload?.action === "request" ? "request" : null;
  const repositoryFullName =
    typeof payload?.repository === "string" && /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(payload.repository)
      ? payload.repository
      : null;
  const prNumber =
    Number.isInteger(payload?.pullRequest) && payload.pullRequest > 0
      ? (payload.pullRequest as number)
      : null;
  const headSha = parsePrReviewSha(payload?.headSha);
  const baseSha = parsePrReviewSha(payload?.baseSha);
  const agent = parseDispatchAgent(payload?.agent ?? "codex");
  if (
    !action ||
    !repositoryFullName ||
    prNumber === null ||
    !headSha ||
    !agent ||
    !DISPATCH_AGENTS.includes(agent) ||
    (action === "request" && !baseSha)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const target = { repositoryFullName, prNumber, headSha, agent };

  if (action === "status") {
    const { job, gate } = await getPrReviewGate(target);
    return NextResponse.json(
      {
        ...gate,
        message: describePrReviewGateState(gate),
        ...(job ? { jobId: job.id, host: job.claimedByHost ?? job.targetHost } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const runId =
    typeof payload?.runId === "string" || typeof payload?.runId === "number"
      ? String(payload.runId).replace(/[^0-9]/g, "").slice(0, 32) || null
      : null;
  const result = await requestPrReviewJob({ target, baseSha: baseSha!, workflowRunId: runId });
  if (!result.ok) {
    return NextResponse.json(
      { state: "failed", reason: result.message, message: result.message },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      ...result.gate,
      created: result.created,
      jobId: result.job.id,
      message: describePrReviewGateState(result.gate),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
