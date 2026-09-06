import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import {
  deferPendingSessionRequests,
  describeSessionAnswerModeRejection,
  parseSessionAnswerInApp,
  setSessionAnswerInApp,
} from "@/lib/dispatch/session-answer-mode";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 質問・計画の返事をClaude Codeアプリ（端末）側で受け取るかを切り替える入口（#2822）。
 *
 * **押すのは人。** ここは`DispatchSession.answerInApp`を書き換えるだけで、端末へキーを送る
 * 経路（`send-keys`）は持たない。効かせるのはフックの受け口
 * （`../question`・`../plan`）で、ONのあいだ待ちを作らなくなる。
 *
 * **ONにしたときは、いま待っている計画・質問をその場で畳む。** 畳まないと、押した本人の
 * 目の前に「押しても行き先が変わらないパネル」が待ち時間いっぱい残る。畳めばフックは
 * `DEFERRED`を読んで降り、同じ質問がClaude Codeアプリ／端末へ出る（画面の
 * 「端末・Remote Controlで答える」を押したのと同じ結末で、経路も同じ）。
 *
 * 認証はSupabaseのログインセッション（`/api/dispatch/question-answer`と同じ）。サブPC側が
 * 叩く`sessions/`配下の他の受け口だけが共有シークレット認証で、経路ごとに境界を分けている。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const host = typeof payload?.host === "string" && payload.host ? payload.host : null;
  const tmuxSessionName =
    typeof payload?.tmuxSessionName === "string" && payload.tmuxSessionName
      ? payload.tmuxSessionName
      : null;
  const answerInApp = parseSessionAnswerInApp(payload?.answerInApp);
  if (!host || !tmuxSessionName || answerInApp === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await setSessionAnswerInApp({ host, tmuxSessionName, answerInApp });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.rejection,
        message: describeSessionAnswerModeRejection(result.rejection),
      },
      { status: 409 },
    );
  }

  // **畳めなくても切り替えは成功。** 決まった直後・期限切れに当たっただけのことが普通に
  // 起き、そのときは待ちがもう無いので目的は達している
  const repositoryFullName =
    typeof payload?.repository === "string" ? payload.repository : null;
  const issueNumber = Number.isInteger(payload?.issue) ? (payload.issue as number) : null;
  let deferred = { plan: false, question: false };
  if (answerInApp && repositoryFullName && issueNumber !== null) {
    deferred = await deferPendingSessionRequests({
      repositoryFullName,
      issueNumber,
      decidedByUserId: user.id,
    });
  }

  return NextResponse.json(
    { ok: true, answerInApp, deferred },
    { headers: { "Cache-Control": "no-store" } },
  );
}
