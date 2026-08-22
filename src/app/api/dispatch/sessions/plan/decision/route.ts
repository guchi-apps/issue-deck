import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { pollSessionPlanRequest, releaseSessionPlanRequest } from "@/lib/dispatch/plan-requests";

/**
 * 計画への返事を、計画を出したセッション側が受け取る口（#2061）。
 *
 * 叩くのは`scripts/session-notify.sh`——`ExitPlanMode`の`PreToolUse`フックが計画を投稿
 * （`../route.ts`）したあと、ここを数秒おきに引いて`WAITING`でなくなるのを待つ。決まった内容は
 * そのままClaude Codeの許可判定（`hookSpecificOutput.permissionDecision`）になる。
 *
 * - `APPROVED` … `allow`（承認プロンプトを出さずに実装へ進む）
 * - `REVISION_REQUESTED` … `deny` ＋ `revisionText`（Claudeが読んで計画を練り直す）
 * - `DEFERRED` / `EXPIRED` … フックは何も返さずに終える（端末に従来どおりの承認プロンプトが出る）
 *
 * **`POST`は「待つのをやめた」の申告**（#2108）。issue-deckへ届かない状態が続いてフックが待ちを
 * 降りるときに叩く。伝えないと画面は待ち時間いっぱいカウントダウンを出し続け、**押しても誰も
 * 受け取らないボタン**が残る。応答は`GET`と同じ形で、降りる直前に押されていればその結論が返る。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`../`と同じ共有シークレット（`DISPATCH_SECRET`）。
 * **画面から押す側は別の口**（`/api/dispatch/plan-decision`。あちらはログインセッション認証）で、
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

  const outcome = await pollSessionPlanRequest(id);
  if (!outcome) {
    // **見つからないのは異常ではない**（DBを作り直した・古いidを引いた）。フックは
    // 「待つ相手が居ない」として待つのをやめ、端末の承認プロンプトへ倒す
    return NextResponse.json(
      { status: "GONE" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { status: outcome.status, revisionText: outcome.revisionText },
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

  const outcome = await releaseSessionPlanRequest(id);
  if (!outcome) {
    return NextResponse.json(
      { status: "GONE" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { status: outcome.status, revisionText: outcome.revisionText },
    { headers: { "Cache-Control": "no-store" } },
  );
}
