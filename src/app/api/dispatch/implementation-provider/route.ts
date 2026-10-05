import { NextResponse, type NextRequest } from "next/server";
import { parseDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { recordImplementationRun, resolveImplementationProvider } from "@/lib/dispatch/implementation-provider";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/** 実装直前のActions記録と、PRレビューからの読取。既存の進捗報告と同じ認証。 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: auth }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: auth }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const repositoryFullName = payload?.repository;
  const issueNumber = payload?.issueNumber;
  if (typeof repositoryFullName !== "string" || repositoryFullName.length > 191 || !/^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(repositoryFullName)
      || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (payload.action === "record") {
    const agent = parseDispatchAgent(payload.agent);
    const runId = payload.runId;
    const attempt = payload.attempt;
    if (!agent || typeof runId !== "string" || !/^[0-9]{1,32}$/.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      await recordImplementationRun({ repositoryFullName, issueNumber, agent, source: "actions",
        runKey: `actions:${runId}:${attempt}`, startedAt: new Date() });
    } catch (error) {
      if (error instanceof Error && error.message === "implementation_run_conflict") {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  }
  if (payload.action !== "resolve") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const provider = await resolveImplementationProvider(repositoryFullName, issueNumber);
  return NextResponse.json(provider ? { provider, source: "implementation" } : { error: "implementation_provider_unknown" },
    { status: provider ? 200 : 409, headers: { "Cache-Control": "no-store" } });
}
