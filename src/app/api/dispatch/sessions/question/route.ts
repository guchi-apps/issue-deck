import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { createSessionQuestionRequest } from "@/lib/dispatch/question-requests";
import { parseSessionHostName, requestSessionCheckUser } from "@/lib/dispatch/session-plan";
import {
  parseSessionQuestionWaitSeconds,
  parseSessionQuestions,
} from "@/lib/dispatch/session-question-request";

/**
 * 実装セッションが`AskUserQuestion`で聞いた質問の受け口（#2189）。
 *
 * 送るのは`scripts/session-notify.sh`で、`AskUserQuestion`の`PreToolUse`フックから叩く。
 * **質問がセッションの中（端末のTUI）にしか無い状態を無くすための入口。**
 * 計画の受け口（`../plan/route.ts`・#2061）と対になっている。
 *
 * **Issueコメントは投稿しない。** 聞かれただけで答えていないものがIssueに増えると、後から
 * 読む人には何が決まったのか分からない。代わりに`00.check-user`＋`01.check-input`を付けて
 * 「人を待っている」ことだけを残し、質問と回答は**答えたときに1件のコメント**として残す
 * （`POST /api/dispatch/question-answer`）。
 *
 * **様子の報告（`../activity`）とは別の入口にする。** あちらはDBの行を更新するだけで、対象の
 * 行が無ければ何もしない。質問の回答待ちはpollerが1巡してDispatchSessionの行ができているかとは
 * 無関係に成立させる必要がある（質問は起動から数分で出ることがある）。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const questions = parseSessionQuestions(payload?.questions);
  if (!target || !questions) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 形が想定外のものは**受け付けずにnullへ倒す**（リクエスト自体は拒否しない）。
  // 質問が画面に出ることの方が価値が高く、付随情報が欠けても待ちを作る意味は変わらない
  const hostName = parseSessionHostName(payload?.hostName);

  // **待ち時間が`0`（ホスト側で無効にしている）なら作らない。** 作ると、フックは待たないのに
  // 画面には押しても誰も受け取らないパネルが残る。
  const waitSeconds = parseSessionQuestionWaitSeconds(payload?.waitSeconds);
  let questionRequestId: string | null = null;
  if (waitSeconds > 0) {
    try {
      const created = await createSessionQuestionRequest({
        repositoryFullName: target.repositoryFullName,
        issueNumber: target.issueNumber,
        hostName,
        questions,
        waitSeconds,
      });
      questionRequestId = created.id;
    } catch (error) {
      // **作れなくても成功として扱う。** 待てないだけで、答える経路（端末・Remote Control）は
      // そのまま残っている
      console.error(
        `[dispatch] 質問の回答待ちを作れませんでした（${target.repositoryFullName}#${target.issueNumber}）`,
        error,
      );
    }
  }

  // **ラベルは待ちを作れたかどうかと切り離す。** 質問が出た＝人を待っているのは確かで、
  // 画面から答えられるかどうかとは別の事実。ここを待ちの成否に紐付けると、
  // 画面にも一覧にも「待っている」ことが出ないIssueができる
  const labeled = await requestSessionCheckUser({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
  });

  // 付けられなくても200で返す。呼び出し側（フック）は再送の判断ができる相手ではなく、
  // 非0を返してもセッションのログにエラーが増えるだけになる
  return NextResponse.json(
    { ok: true, labeled, questionRequestId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
