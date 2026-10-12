import { after, NextResponse, type NextRequest } from "next/server";

import { claimEvent, handleMessageEvent, releaseEvent, type SlackMessageEvent } from "@/lib/slack/intake";
import { authenticateSlackRequest } from "@/lib/slack/route-helpers";

type EventPayload = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackMessageEvent;
};

/**
 * Slack Events APIの受け口（#4454）。署名検証→処理済み確認→即時ack（3秒以内）→非同期で処理。
 * Slackは応答が遅いと同じイベントを再送するため、`event_id`で再送を無視する。
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
  if (!(await claimEvent(`event:${eventId}`, event.ts ?? null))) return NextResponse.json({ ok: true, duplicate: true });

  after(async () => {
    try {
      await handleMessageEvent(auth.ctx, teamId, event);
    } catch (error) {
      console.error("[slack-intake] イベントの処理に失敗しました", error);
      // 処理済みのまま残すと、再送されたイベントが`duplicate`で恒久的に捨てられる。外して再処理できる状態に戻す
      await releaseEvent(`event:${eventId}`).catch((releaseError) =>
        console.error("[slack-intake] 処理済み記録を外せませんでした", releaseError),
      );
    }
  });
  return NextResponse.json({ ok: true });
}
