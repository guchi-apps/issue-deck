import { NextResponse } from "next/server";

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
export async function POST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isPushConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const targets = await db.pushSubscription.findMany({
    where: { userId },
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
    // **このボタンは設定画面からしか押せない＝押した瞬間はアプリが必ず表示中**なので、
    // Service Workerの「表示中なら出さない」に当たって毎回握りつぶされていた（#2195）
    force: true,
  });

  return NextResponse.json({ ok: true, ...result });
}
