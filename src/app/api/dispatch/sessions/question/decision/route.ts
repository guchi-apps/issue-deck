import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import {
  pollSessionQuestionRequest,
  releaseSessionQuestionRequest,
} from "@/lib/dispatch/question-requests";

/**
 * 質問への回答を、質問したセッション側が受け取る口（#2189）。
 *
 * 叩くのは`scripts/session-notify.sh`——`AskUserQuestion`の`PreToolUse`フックが質問を送った
 * （`../route.ts`）あと、ここを数秒おきに引いて`WAITING`でなくなるのを待つ。
 *
 * - `ANSWERED` … `allow` ＋ `updatedInput.answers`（Claude Codeはこの回答をそのまま結果にする）
 * - `DEFERRED` / `EXPIRED` … フックは何も返さずに終える（端末に従来どおりの選択フォームが出る）
 *
 * **`POST`は「待つのをやめた」の申告。** issue-deckへ届かない状態が続いてフックが待ちを降りる
 * ときに叩く。伝えないと画面は待ち時間いっぱいカウントダウンを出し続け、**押しても誰も
 * 受け取らないボタン**が残る。応答は`GET`と同じ形で、降りる直前に押されていればその結論が返る。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`../`と同じ共有シークレット（`DISPATCH_SECRET`）。
 * **画面から押す側は別の口**（`/api/dispatch/question-answer`。あちらはログインセッション認証）で、
 * ディレクトリごとに認証の境界を分けている。
 */
export async function GET(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const outcome = await pollSessionQuestionRequest(id);
  if (!outcome) {
    // **見つからないのは異常ではない**（DBを作り直した・古いidを引いた）。フックは
    // 「待つ相手が居ない」として待つのをやめ、端末の選択フォームへ倒す
    return NextResponse.json({ status: "GONE" }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { status: outcome.status, answers: outcome.answers },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const id = typeof payload?.id === "string" ? payload.id : null;
  if (!id) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const outcome = await releaseSessionQuestionRequest(id);
  if (!outcome) {
    return NextResponse.json({ status: "GONE" }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { status: outcome.status, answers: outcome.answers },
    { headers: { "Cache-Control": "no-store" } },
  );
}
