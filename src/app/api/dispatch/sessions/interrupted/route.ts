import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { escalateInterruptedSession } from "@/lib/dispatch/session-escalation";
import { parseDispatchSessionName, parseRemoteControlUrl } from "@/lib/dispatch/session-state";

/** コメントに載せる`detail`の上限。pollerが持つ固定の文言しか来ないので短くてよい */
const MAX_DETAIL_LENGTH = 200;

/**
 * 中断・停滞したまま止まっているセッションの引き上げ（#1971・#2280・#2655）。
 *
 * 送るのは`scripts/session-notify.sh`で、入口はpollerが合成する`SessionInterrupted`。原因は
 * `reason`で2種類ある。
 *   - `api_error`: Claude CodeがAPIの一時エラーを再試行しきるとturnが打ち切られ、
 *     **`Stop`フックが飛ばない**ため、フックだけを待っていると誰にも伝わらない。pollerが
 *     自動再開を上限まで試したあとに叩く
 *   - `tool_call_stall`: ツールを呼び出したつもりでテキストに書いただけで実際には呼ばれず、
 *     `Stop`は正常に発火するが実質何も進んでいないセッション。自動での再送信はしない
 * どちらも**1セッションにつき1回**だけ叩く（送ったかどうかの記録はホスト側の`.resume`・
 * `.tool-call-stall`が持つ）。
 *
 * **#2280より前はSignalyへ通知するだけだった。** webhookを消したので、異常終了（#1217）・
 * 起動確認での足止め（#1465）と同じ形——Issueコメント＋`00.check-user`＋`01.check-blocked`——へ
 * 寄せた。理由が`01.check-input`ではなく`01.check-blocked`なのは、ユーザーがやることが
 * 「回答」ではなく**続け方の指示**だから。
 *
 * **`../activity`へは流せない。** あちらは「今このセッションが何をしているか」を書く受け口で、
 * 中断はそれを言えない（`working`のまま止まっている、が最後に分かっている事実）。ラベルだけを
 * 立てて通すこともできるが、それだと**何が起きたのかがIssueに残らず、理由ラベルも`input`に
 * なる**。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
 *
 * **失敗しても呼び出し側は実装を止めない。** `session-notify.sh`は何が起きても`exit 0`で返す。
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
  const hostName = parseDispatchHostName(payload?.hostName);
  const tmuxSessionName = parseDispatchSessionName(payload?.tmuxSessionName);
  if (!target || !hostName || !tmuxSessionName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 形が想定外なら**載せずに通す**（`../activity`のURLと同じ扱い）。付帯情報が1つ欠けることより、
  // 止まっていること自体が伝わらないことの方が損失が大きい
  const detail =
    typeof payload?.detail === "string" && payload.detail.trim()
      ? payload.detail.trim().slice(0, MAX_DETAIL_LENGTH)
      : null;
  const remoteControlUrl = parseRemoteControlUrl(payload?.remoteControlUrl);
  // 未知の値・省略時は`api_error`（#1971からの後方互換）。原因ごとの文言分岐は
  // `session-escalation.ts`が持つ（#2655で`tool_call_stall`を追加）。
  const reason = payload?.reason === "tool_call_stall" ? "tool_call_stall" : "api_error";

  const escalated = await escalateInterruptedSession({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    tmuxSessionName,
    detail,
    remoteControlUrl,
    reason,
  });

  // 引き上げられなくても200で返す。呼び出し側（フック）に再送の判断をさせる相手はいない
  return NextResponse.json({ ok: true, escalated }, { headers: { "Cache-Control": "no-store" } });
}
