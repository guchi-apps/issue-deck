import { after, NextResponse, type NextRequest } from "next/server";

import { acceptMessageEvent, processAcceptedEvent, type AcceptedEvent, type SlackMessageEvent } from "@/lib/slack/intake";
import { authenticateSlackRequest } from "@/lib/slack/route-helpers";

type EventPayload = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackMessageEvent;
};

/**
 * Slack Events APIの受け口（#4454）。署名検証→受付（DBへの保存）→即時ack（3秒以内）→非同期で処理。
 * Slackは応答が遅いと同じイベントを再送するため、`event_id`で再送を無視する。
 *
 * **ack前に依頼をDBへ残す**（#4488）。保存に失敗したら500を返し、Slackに同じイベントを再送させる（処理済み記録も
 * 同じトランザクションで巻き戻る）。ack後の処理が失敗・中断しても依頼は残り、失敗状態からの「再開」か巡回で続けられる。
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateSlackRequest(request);
  if (!auth.ok) return auth.response;
  const payload = JSON.parse(auth.rawBody || "{}") as EventPayload;

  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return NextResponse.json({ challenge: payload.challenge });
  }
  if (payload.type !== "event_callback" || !payload.event || !payload.team_id || !payload.event_id) {
    return NextResponse.json({ ok: true });
  }
  const { event, team_id: teamId, event_id: eventId } = payload;
  let accepted: AcceptedEvent;
  try {
    accepted = await acceptMessageEvent(auth.config, teamId, eventId, event);
  } catch (error) {
    console.error("[slack-intake] イベントを保存できませんでした（Slackの再送を待ちます）", error);
    return NextResponse.json({ error: "intake_unavailable" }, { status: 500 });
  }
  if (accepted.kind === "duplicate") return NextResponse.json({ ok: true, duplicate: true });

  after(async () => {
    try {
      await processAcceptedEvent(auth.ctx, accepted);
    } catch (error) {
      // 依頼はDBに残っている（失敗状態にできなかった場合も待ち状態のまま残り、巡回が拾い直す）
      console.error("[slack-intake] イベントの処理に失敗しました", error);
    }
  });
  return NextResponse.json({ ok: true });
}
