import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { isPushConfigured, sendPushNotification } from "@/lib/notifications/push";

/**
 * テスト通知（#838）。設定画面のボタンから、**自分の購読にだけ**送る。
 *
 * Push通知は「確認待ちになるまで待たないと確かめられない」——鍵の設定、Service Workerの
 * 登録、OS側の許可のどこで止まっているのかも分からない。ここを押して届けば、
 * 残りは確認待ちが起きるのを待つだけだと分かる。
 */
/**
 * 送り先を1端末に絞る`endpointKey`（#4275）。iOSアプリは「この端末」の状態を表示しているので、
 * 他端末へ送ると表示と食い違う。省略時は従来どおり自分の全購読へ送る
 */
const ENDPOINT_KEY_PATTERN = /^[0-9a-f]{64}$/;

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isPushConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as { endpointKey?: unknown } | null;
  const endpointKey = body?.endpointKey;
  if (endpointKey !== undefined && (typeof endpointKey !== "string" || !ENDPOINT_KEY_PATTERN.test(endpointKey))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const targets = await db.pushSubscription.findMany({
    where: { userId, ...(endpointKey ? { endpointKey } : {}) },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (targets.length === 0) {
    return NextResponse.json({ error: "no_subscription" }, { status: 400 });
  }

  const result = await sendPushNotification(targets, {
    title: "IssueDeckのテスト通知",
    body: "この通知が見えていれば、確認待ちになったときも届きます",
    url: "/dashboard",
    // 確認待ちの通知（`check-user:<id>`）と混ざらない鍵にする
    tag: "test",
    // **古いService Workerが残っている端末のための保険**（#2195・#2196）。新しいsw.jsは
    // 表示中かどうかで出し分けないので読まないが、更新前の端末では抑止が生きており、
    // これが無いと押した設定画面が表示中であることを理由に握りつぶされる
    force: true,
  });

  return NextResponse.json({ ok: true, ...result });
}
