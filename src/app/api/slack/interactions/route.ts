import { after, NextResponse, type NextRequest } from "next/server";

import { acceptIssueConfirmation, claimEvent, handleInteraction, processPendingRequest, type SlackInteractionPayload } from "@/lib/slack/intake";
import { authenticateSlackRequest } from "@/lib/slack/route-helpers";

/** 選択メニュー・ボタンの操作（`application/x-www-form-urlencoded`の`payload`）。署名検証→起案確定のDB保存→ack→非同期で処理 */
export async function POST(request: NextRequest) {
  const auth = await authenticateSlackRequest(request);
  if (!auth.ok) return auth.response;
  const raw = new URLSearchParams(auth.rawBody).get("payload");
  if (!raw) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (payload.type !== "block_actions") return new NextResponse(null, { status: 200 });
  // GitHub更新の承認は、ack前に永続化する。保存失敗はSlackへ再送を求める。
  let confirmation: string | null | undefined;
  try {
    confirmation = await acceptIssueConfirmation(auth.ctx.config, payload);
  } catch {
    return NextResponse.json({ error: "intake_unavailable" }, { status: 503 });
  }
  if (confirmation !== undefined) {
    if (confirmation) after(async () => {
      try { await processPendingRequest(auth.ctx, confirmation); }
      catch (error) { console.error("[slack-intake] 保存済みの確定操作を再開待ちにします", error); }
    });
    return new NextResponse(null, { status: 200 });
  }
  // 連打・再送は、同じ操作（trigger_id）を1回だけ処理する
  if (payload.trigger_id && !(await claimEvent(`action:${payload.trigger_id}`, null))) {
    return new NextResponse(null, { status: 200 });
  }
  after(async () => {
    try {
      await handleInteraction(auth.ctx, payload);
    } catch (error) {
      console.error("[slack-intake] 操作の処理に失敗しました", error);
    }
  });
  return new NextResponse(null, { status: 200 });
}
