import { NextResponse, type NextRequest } from "next/server";

import {
  claimInternalSession,
  pauseInternalByReport,
  readInternalStatus,
  recordInternalReview,
  recordInternalTest,
  releaseInternalSession,
  resumeInternal,
  type Actor,
  type InternalReportError,
} from "@/lib/release-fix-internal-run";
import type { ReviewReport } from "@/lib/release-fix-internal";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * リリース修正の内部確認（#4410）の報告と状態の取得。認証は`POST /api/progress`と同じ共有シークレット。
 *
 * - `review` … 独立レビューの結果（verdict・新しい指摘・解消した指摘と根拠・再発した指摘）を記録し、往復を1つ進める
 * - `test` … 必要テストの結果を記録する（最新の往復へ、確認した対象SHAつきで）
 * - `status` … 現在のゲート判定（修正PRを作ってよいか）・指摘・稼働時間と予算・担当・一時停止の原因を返す。**読み取り専用**
 * - `claim` … 担当の取得（`takeover: true`で別担当からの引き継ぎ）。応答の`epoch`を以降の報告へ添える
 * - `release` … 担当の解放（記録は保持）
 * - `pause` … 実行環境の障害（`environment`）・本人判断や権限の不足（`needs_decision`）で一時停止する
 * - `resume` … 回復済みの実行障害だけ入力なしで再開する。予算の追加・方針が要る停止は画面から人が再開する
 *
 * 報告（review・test・pause・release）には`assignee`と`epoch`を添える。担当が変わった後の旧担当の遅延報告は弾く。
 *
 * **対象のSHAはクライアントから受け取らない。** サーバーが`issue-<番号>`ブランチのHEADを取り直し、
 * 進行中の内部確認つき修正系列に結び付かない報告は記録しない。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const action = ["review", "test", "status", "claim", "release", "pause", "resume"].includes(payload?.action) ? (payload.action as string) : null;
  const repositoryFullName =
    typeof payload?.repository === "string" && /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/.test(payload.repository) ? payload.repository : null;
  const issueNumber = Number.isInteger(payload?.issue) && payload.issue > 0 ? (payload.issue as number) : null;
  if (!action || !repositoryFullName || issueNumber === null) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const fail = (result: InternalReportError) =>
    NextResponse.json({ error: result.error, message: result.message }, { status: result.error === "series_not_found" || result.error === "repository_not_found" || result.error === "branch_not_found" ? 404 : 409, ...noStore });
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? v.slice(0, max) : null);

  const actor: Actor = {
    assignee: text(payload?.assignee, 120),
    epoch: Number.isInteger(payload?.epoch) ? (payload.epoch as number) : null,
  };

  if (action === "claim") {
    const assignee = text(payload?.assignee, 120);
    if (!assignee) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const result = await claimInternalSession({ repositoryFullName, issueNumber, assignee, takeover: payload?.takeover === true });
    return result.ok ? NextResponse.json({ ok: true, epoch: result.epoch, handover: result.handover, ...result.status }, noStore) : fail(result);
  }

  if (action === "release") {
    const result = await releaseInternalSession({ repositoryFullName, issueNumber, actor });
    return result.ok ? NextResponse.json({ ok: true, ...result.status }, noStore) : fail(result);
  }

  if (action === "pause") {
    const kind = payload?.kind === "environment" || payload?.kind === "needs_decision" ? payload.kind : null;
    if (!kind) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const result = await pauseInternalByReport({ repositoryFullName, issueNumber, kind, detail: text(payload?.detail, 500), actor });
    return result.ok ? NextResponse.json({ ok: true, ...result.status }, noStore) : fail(result);
  }

  if (action === "resume") {
    const result = await resumeInternal({ repositoryFullName, issueNumber, assignee: actor.assignee, by: actor.assignee, autoOnly: true });
    return result.ok ? NextResponse.json({ ok: true, ...result.status }, noStore) : fail(result);
  }

  if (action === "status") {
    const result = await readInternalStatus(repositoryFullName, issueNumber);
    return result.ok ? NextResponse.json({ ok: true, ...result.status }, noStore) : fail(result);
  }

  if (action === "test") {
    const state = payload?.state === "passed" || payload?.state === "failed" ? payload.state : null;
    if (!state) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const result = await recordInternalTest({ repositoryFullName, issueNumber, state, summary: text(payload?.summary, 8000), actor });
    return result.ok ? NextResponse.json({ ok: true, round: result.round, ...result.status }, noStore) : fail(result);
  }

  const verdict = payload?.verdict === "pass" || payload?.verdict === "findings" ? payload.verdict : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const newFindings = Array.isArray(payload?.newFindings)
    ? (payload.newFindings as unknown[]).flatMap((x) => {
        const o = x as { title?: unknown; detail?: unknown } | null;
        return o && typeof o.title === "string" && o.title.trim() !== "" ? [{ title: o.title, detail: typeof o.detail === "string" ? o.detail : null }] : [];
      })
    : [];
  const resolved = Array.isArray(payload?.resolved)
    ? (payload.resolved as unknown[]).flatMap((x) => {
        const o = x as { key?: unknown; resolution?: unknown } | null;
        return o && typeof o.key === "string" ? [{ key: o.key, resolution: typeof o.resolution === "string" ? o.resolution : "" }] : [];
      })
    : [];
  const stillOpen = strings(payload?.stillOpen) ?? [];
  if (!verdict) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const report: ReviewReport = { verdict, newFindings, stillOpen, resolved };
  const result = await recordInternalReview({ repositoryFullName, issueNumber, report, summary: text(payload?.summary, 8000), actor });
  return result.ok ? NextResponse.json({ ok: true, round: result.round, ...result.status }, noStore) : fail(result);
}
