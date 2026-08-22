import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { decideSessionPlanRequest } from "@/lib/dispatch/plan-requests";
import {
  buildSessionPlanDecisionCommentBody,
  describeSessionPlanDecisionRejection,
  parseSessionPlanDecision,
  parseSessionPlanRevision,
} from "@/lib/dispatch/session-plan-request";
import { createComment } from "@/lib/github/issues-api";
import { posterMarker } from "@/lib/github/project-status-dispatch";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

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
