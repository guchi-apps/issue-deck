import { NextResponse, type NextRequest } from "next/server";

import { requestReleaseVerifyJob } from "@/lib/dispatch/release-verify-jobs";
import { parsePrReviewSha } from "@/lib/dispatch/pr-review";
import { authorizeProgressReport } from "@/lib/progress-report-auth";
import {
  evaluateReleaseMergeGate,
  parseReleaseVerificationKind,
  parseReleaseVerificationState,
} from "@/lib/release-merge-gate";
import {
  listReleaseVerificationRecords,
  recordReleaseVerificationResult,
  registerReleaseVerification,
} from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";

/**
 * 固定リリースの検証記録（#4212）の依頼・結果の記録・状態の取得。
 *
 * 認証は`POST /api/progress`と同じ共有シークレット。
 * - `request` … 対象（リポジトリ・PR・base/head SHA）の行を作り、統合検証のジョブを積む（#4237）。冪等で、同じ対象は重複しない
 * - `report` … 種別ごとの結果を記録する。依頼の無い対象・種別には書かない
 * - `status` … 現在のSHAに対する検証区分のゲート判定を返す
 *
 * リクエスト: `{ "action": "request|report|status", "repository": "owner/name", "pullRequest": 123,
 * "baseSha": "…", "headSha": "…", "kind"?: "integration|ai_review", "state"?: "passed|…" }`
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const action = ["request", "report", "status"].includes(payload?.action) ? (payload.action as string) : null;
  const repoFullName =
    typeof payload?.repository === "string" && /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(payload.repository)
      ? payload.repository
      : null;
  const prNumber =
    Number.isInteger(payload?.pullRequest) && payload.pullRequest > 0 ? (payload.pullRequest as number) : null;
  const baseSha = parsePrReviewSha(payload?.baseSha);
  const headSha = parsePrReviewSha(payload?.headSha);
  if (!action || !repoFullName || prNumber === null || !baseSha || !headSha) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const target = { repoFullName, prNumber, baseSha, headSha };
  const noStore = { headers: { "Cache-Control": "no-store" } };

  if (action === "request") {
    const { created } = await registerReleaseVerification(target);
    // 実行を依頼する（#4237）。積めなくても記録の行は残し、`integration`は失敗として記録される
    const queued = await requestReleaseVerifyJob(target);
    return NextResponse.json(
      {
        ok: true,
        created,
        integration: queued.ok ? queued.outcome : queued.rejection,
        ...(queued.ok && queued.outcome === "queued" ? { jobId: queued.job.id } : {}),
        ...(queued.ok ? {} : { message: queued.message }),
      },
      noStore,
    );
  }

  if (action === "report") {
    const kind = parseReleaseVerificationKind(payload?.kind);
    const state = parseReleaseVerificationState(payload?.state);
    if (!kind || !state) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
    const ok = await recordReleaseVerificationResult(target, {
      kind,
      state,
      agent: str(payload?.agent, 64),
      summary: str(payload?.summary, 20000),
      findings: payload?.findings,
      unverifiedScope: str(payload?.unverifiedScope, 5000),
      evidenceUrl: str(payload?.evidenceUrl, 500),
      message: str(payload?.message, 5000),
    });
    if (!ok) return NextResponse.json({ error: "not_requested" }, { status: 404 });
    return NextResponse.json({ ok: true }, noStore);
  }

  const records = await listReleaseVerificationRecords(repoFullName, prNumber);
  const gate = evaluateReleaseMergeGate({
    current: { baseSha, headSha },
    records,
    enforced: getReleaseVerificationConfig(repoFullName).enforced,
  });
  return NextResponse.json(gate, noStore);
}
