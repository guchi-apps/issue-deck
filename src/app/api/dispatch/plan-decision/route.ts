import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import type { ClaudeLocalModel, CodexLocalModel } from "@/lib/app-settings";
import { notifyCodexSessionDecision } from "@/lib/dispatch/codex-decision-notify";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import {
  decideSessionPlanRequest,
  recordSessionPlanCodexDelivery,
} from "@/lib/dispatch/plan-requests";
import { resolveSessionPlanCheckUser } from "@/lib/dispatch/session-plan";
import { advanceSessionPlanProgress } from "@/lib/dispatch/session-plan-progress";
import {
  buildSessionPlanDecisionCommentBody,
  describeSessionPlanDecisionRejection,
  parseSessionPlanDecision,
  parseSessionPlanHandoffModel,
  parseSessionPlanRevision,
} from "@/lib/dispatch/session-plan-request";
import { createComment } from "@/lib/github/issues-api";
import { posterMarker } from "@/lib/github/project-status-dispatch";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";
import { db } from "@/lib/db";

/**
 * 計画の承認・修正を画面から送る入口（#2061）。
 *
 * **押すのは人。** ここは押された内容を`SessionPlanRequest`へ書くだけで、端末へキーを送る
 * 経路（`send-keys`）は一切持たない。受け取るのは計画を出したフックで、
 * `GET /api/dispatch/sessions/plan/decision`を引いて結論をClaude Codeの許可判定として返す。
 *
 * 認証はSupabaseのログインセッション（`GET/POST /api/dispatch`と同じ）。サブPC側が叩く
 * `sessions/`配下だけが共有シークレット認証で、経路ごとに認証の境界を分けている。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const id = typeof payload?.id === "string" ? payload.id : null;
  const decision = parseSessionPlanDecision(payload?.decision);
  if (!id || !decision) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 修正は本文が要る。**空のまま送れてしまうと、Claudeは何を直せばよいのか分からないまま
  // 計画を作り直す**ことになる（`deny`の理由がそのまま次の指示になる）
  const revisionText = decision === "revise" ? parseSessionPlanRevision(payload?.text) : null;
  if (decision === "revise" && !revisionText) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let handoff: { agent: "claude" | "codex"; model: string; hostName: string } | null = null;
  if (decision === "approve" && payload?.handoffModel !== undefined) {
    const pending = await db.sessionPlanRequest.findUnique({
      where: { id },
      select: { repositoryFullName: true, issueNumber: true, status: true },
    });
    if (!pending || pending.status !== "WAITING") {
      return NextResponse.json({ error: "already_decided" }, { status: 409 });
    }
    const session = await findDispatchSessionForIssue({
      repositoryFullName: pending.repositoryFullName,
      issueNumber: pending.issueNumber,
    });
    if (!session || session.state !== "ALIVE") {
      return NextResponse.json({ error: "session_not_available" }, { status: 409 });
    }
    const agent = session.codexThreadKnown === null ? "claude" : "codex";
    // Claude Codeは承認フックが元セッションをその場で実装へ進める。ここでhandoffを積むと
    // 新旧セッションが同じworktreeを同時に触るため、停止と再開をキューで制御できるCodexだけに絞る。
    if (agent !== "codex") {
      return NextResponse.json({ error: "handoff_not_supported" }, { status: 409 });
    }
    const model = parseSessionPlanHandoffModel(payload.handoffModel, agent);
    if (!model) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    handoff = { agent, model, hostName: session.host };
  }

  const result = await decideSessionPlanRequest({
    id,
    decision,
    revisionText,
    decidedByUserId: user.id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.rejection, message: describeSessionPlanDecisionRejection(result.rejection) },
      { status: 409 },
    );
  }

  // **押したことをIssueへ残す**（誰がいつ何を送ったのかが残らないと、後から計画の変遷を
  // 追えない）。**失敗しても成功として返す**——返事はもうDBに入っていてセッションへ届くので、
  // ここで失敗を返すと「効かなかった」と誤解して押し直すことになる
  await recordDecisionComment({
    repositoryFullName: result.request.repositoryFullName,
    issueNumber: result.request.issueNumber,
    decision,
    revisionText,
    login: user.githubLogin,
  });

  // **答えた時点で確認待ちを解く**（#2341）。従来はセッション側のフック任せで、外れるのは
  // 人が答えた直後の`PostToolUse`——しかし**画面から答えた回は承認プロンプトが出ない**ため、
  // その合図が飛ばず`Stop`（turnの終了＝実装が全部終わるまで）まで残ることがある。
  // 押したのに「計画の承認が必要です」とラベルが居座り、まだ何か操作が要るように見えていた。
  //
  // **`defer`では外さない。** 端末・Remote Controlで答えると言っただけで、人はまだ答えていない。
  // ここで外すと待たれていること自体が画面から消える。
  //
  // 外し方はフックと同じ（`removeCheckUserWithReason`）で、`21.plan-required`は残す。
  // **失敗しても成功として返す**——返事はもうDBに入っていてセッションへ届く（コメント投稿と同じ）。
  if (decision !== "defer") {
    await resolveSessionPlanCheckUser({
      repositoryFullName: result.request.repositoryFullName,
      issueNumber: result.request.issueNumber,
    });
  }

  // **承認したら進捗を実装へ進める**（#3213）。修正・端末で答える場合は計画のまま。
  // 失敗しても成功として返す（返事はもうDBに入っていてセッションへ届く）
  if (decision === "approve") {
    await advanceSessionPlanProgress({
      repositoryFullName: result.request.repositoryFullName,
      issueNumber: result.request.issueNumber,
    });
  }

  // 切替を選んだ場合だけ、既存のhandoffジョブとして積む。pollerは要約を書いてから元を
  // 停止するため、同じworktreeを2つのセッションが同時に編集しない。
  let handoffQueued = false;
  if (decision === "approve" && handoff) {
    const queued = await enqueueDispatchJob({
      repositoryFullName: result.request.repositoryFullName,
      issueNumber: result.request.issueNumber,
      hostName: handoff.hostName,
      agent: handoff.agent,
      claudeModel: handoff.agent === "claude" ? (handoff.model as ClaudeLocalModel) : null,
      codexModel: handoff.agent === "codex" ? (handoff.model as CodexLocalModel) : null,
      handoffFrom: handoff.agent,
      handoffTranscript: false,
      requestedByUserId: user.id,
    });
    handoffQueued = queued.ok;
    if (!queued.ok) {
      console.error(`[dispatch] 計画承認後のモデル切替を積めませんでした: ${queued.message}`);
    }
  }

  // **Codexのセッションには、ここから継続指示を積む**（#3218）。あちらは`submit-plan.sh`の
  // 完了を待たずにターンを終えているため、判断を取りに来る当事者がいない
  // （`src/lib/dispatch/codex-decision-notify.ts`）。**`defer`では送らない**——端末で答えると
  // 言っただけで、人はまだ答えていない。**失敗しても成功として返す**（判断はもうDBに入っている）
  if (decision !== "defer" && !handoffQueued) {
    const notified = await notifyCodexSessionDecision({
      repositoryFullName: result.request.repositoryFullName,
      issueNumber: result.request.issueNumber,
      kind: decision === "approve" ? "plan-approved" : "plan-revision",
      requestedByUserId: user.id,
    });
    // **Codexだと分かったときだけ記録する。** Claude Codeのセッション（`not_codex`）と、
    // どちらか分からないとき（`no_session`）は、フックが`report_delivery`で書く側を残す
    if (notified.ok || (notified.reason !== "not_codex" && notified.reason !== "no_session")) {
      await recordSessionPlanCodexDelivery({
        id: result.request.id,
        queued: notified.ok,
        summary: notified.ok ? null : notified.message,
      });
    }
  }

  return NextResponse.json({ request: result.request });
}

async function recordDecisionComment(params: {
  repositoryFullName: string;
  issueNumber: number;
  decision: "approve" | "revise" | "defer";
  revisionText: string | null;
  login: string;
}): Promise<void> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionPlanDecisionCommentBody({
        decision: params.decision,
        revisionText: params.revisionText,
        posterMarker: posterMarker(params.login),
      }),
    });
  } catch (error) {
    console.error(
      `[dispatch] 計画への返事をIssueへ残せませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
  }
}
