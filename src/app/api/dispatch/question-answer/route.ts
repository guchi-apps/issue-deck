import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import {
  decideSessionQuestionRequest,
  findSessionQuestionRequestQuestions,
} from "@/lib/dispatch/question-requests";
import { resolveSessionPlanCheckUser } from "@/lib/dispatch/session-plan";
import {
  buildSessionQuestionAnswerCommentBody,
  buildSessionQuestionAnswers,
  describeSessionQuestionDecisionRejection,
  parseSessionQuestionDecision,
  type SessionQuestion,
  type SessionQuestionDecision,
} from "@/lib/dispatch/session-question-request";
import { createComment } from "@/lib/github/issues-api";
import { posterMarker } from "@/lib/github/project-status-dispatch";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * Claude Codeからの質問に、画面から答える入口（#2189）。
 *
 * **押すのは人。** ここは押された内容を`SessionQuestionRequest`へ書くだけで、端末へキーを送る
 * 経路（`send-keys`）は一切持たない。受け取るのは質問を送ったフックで、
 * `GET /api/dispatch/sessions/question/decision`を引いて回答を`updatedInput.answers`として
 * Claude Codeへ返す。
 *
 * **選んだラベルはDBの質問と突き合わせる**（`buildSessionQuestionAnswers`）。回答はそのまま
 * ツールの入力になり、質問に無い値を載せるとClaude Code側のスキーマ検証で回答ごと弾かれる。
 *
 * 認証はSupabaseのログインセッション（`/api/dispatch/plan-decision`と同じ）。サブPC側が叩く
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
  const decision = parseSessionQuestionDecision(payload?.decision);
  if (!id || !decision) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **質問はDBから引き直す。** 画面が送ってきた質問文を信じると、選択肢に無い文字列を
  // そのままClaude Codeのツール入力へ載せられてしまう
  const questions = decision === "answer" ? await findSessionQuestionRequestQuestions(id) : null;
  if (decision === "answer" && !questions) {
    return NextResponse.json(
      {
        error: "not_found",
        message: describeSessionQuestionDecisionRejection("not_found"),
      },
      { status: 409 },
    );
  }

  const answers = questions ? buildSessionQuestionAnswers(questions, payload?.answers) : null;
  if (decision === "answer" && !answers) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await decideSessionQuestionRequest({
    id,
    decision,
    answers,
    decidedByUserId: user.id,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.rejection,
        message: describeSessionQuestionDecisionRejection(result.rejection),
      },
      { status: 409 },
    );
  }

  // **押したことをIssueへ残す**（誰がいつ何を選んだのかが残らないと、仕様が決まった経緯を
  // 追えない）。**失敗しても成功として返す**——回答はもうDBに入っていてセッションへ届くので、
  // ここで失敗を返すと「効かなかった」と誤解して押し直すことになる
  await recordAnswerComment({
    repositoryFullName: result.request.repositoryFullName,
    issueNumber: result.request.issueNumber,
    decision,
    questions: questions ?? result.request.questions,
    answers,
    login: user.githubLogin,
  });

  // **答えた時点で確認待ちを解く**（#2341。計画への返事と同じ理由・同じ作法）。画面から
  // 答えた回は選択フォームが出ないため、フックの「答えた合図」（`PostToolUse`）が飛ばず、
  // `00.check-user`が`Stop`まで残ることがある。**`defer`では外さない**（人はまだ答えていない）。
  if (decision !== "defer") {
    await resolveSessionPlanCheckUser({
      repositoryFullName: result.request.repositoryFullName,
      issueNumber: result.request.issueNumber,
    });
  }

  return NextResponse.json({ request: result.request });
}

async function recordAnswerComment(params: {
  repositoryFullName: string;
  issueNumber: number;
  decision: SessionQuestionDecision;
  questions: readonly SessionQuestion[];
  answers: Record<string, string> | null;
  login: string;
}): Promise<void> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionQuestionAnswerCommentBody({
        decision: params.decision,
        questions: params.questions,
        answers: params.answers,
        posterMarker: posterMarker(params.login),
      }),
    });
  } catch (error) {
    console.error(
      `[dispatch] 質問への回答をIssueへ残せませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
  }
}
