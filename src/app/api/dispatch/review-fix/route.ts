import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { authorizeProgressReport } from "@/lib/progress-report-auth";
import { recordReviewFixHandoffStarted } from "@/lib/github/pull-request-auto-repair-start";
import { requestReviewFixJob, validateReviewFixTarget } from "@/lib/dispatch/review-fix-jobs";

export async function POST(request: NextRequest) {
  const p = await request.json().catch(() => null);
  const auth = p?.action === "validate" ? authorizeDispatch(request.headers.get("authorization")) : authorizeProgressReport(request.headers.get("authorization"));
  if (auth !== "ok") return NextResponse.json({ error: auth }, { status: auth === "not_configured" ? 503 : 401 });
  if (p?.action === "validate") {
    const job = typeof p.jobId === "string" ? await db.dispatchJob.findUnique({ where: { id: p.jobId } }) : null;
    if (!job || job.kind !== "REVIEW_FIX" || !["CLAIMED", "RUNNING"].includes(job.status) || job.claimedByHost !== p.host) return NextResponse.json({ error: "invalid_job" }, { status: 409 });
    p.repository = job.repositoryFullName; p.issueNumber = job.issueNumber; p.pullRequest = job.prNumber; p.headSha = job.headSha; p.manual = job.instruction === "manual";
  }
  if (!p || !["request", "validate"].includes(p.action) || typeof p.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(p.repository) || !Number.isSafeInteger(p.issueNumber) || p.issueNumber < 1 || !Number.isSafeInteger(p.pullRequest) || p.pullRequest < 1 || !/^[a-f0-9]{40,64}$/.test(p.headSha ?? "") || typeof p.manual !== "boolean") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (p.action === "request" && (typeof p.runId !== "string" || !/^[0-9]{1,32}$/.test(p.runId))) return NextResponse.json({ error: "invalid_run" }, { status: 400 });
  const target = { repository: p.repository, issueNumber: p.issueNumber, pullRequest: p.pullRequest, headSha: p.headSha, manual: p.manual, runId: p.runId };
  try {
    if (p.action === "validate") return NextResponse.json({ review: await validateReviewFixTarget(target) }, { headers: { "Cache-Control": "no-store" } });
    const job = await requestReviewFixJob(target);
    // Codexへ渡したレビュー修正も自動修復系列に載せる（#4318）。失敗しても依頼自体は成功として返す。
    await recordReviewFixHandoffStarted({ repositoryFullName: p.repository, pullRequestNumber: p.pullRequest }).catch((error: unknown) => {
      console.error("[POST /api/dispatch/review-fix] 系列への登録に失敗:", error);
    });
    return NextResponse.json({ jobId: job.id, status: job.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "レビュー修正を依頼できませんでした" }, { status: 409 });
  }
}
