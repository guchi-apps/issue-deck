import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getVapidConfig, pushEndpointKey } from "@/lib/notifications/push";

/**
 * Push通知の購読（#838）の登録・解除と、設定画面が要る情報の取得。
 *
 * **購読は端末×ブラウザごと**なので、ログインユーザー1人に複数行ぶら下がる。
 * 宛先（`endpoint`）そのものは画面へ返さず、同一判定用のハッシュ（`endpointKey`）だけを返す。
 */

/** `navigator.userAgent`はいくらでも長くできるので、保存前に切る */
const USER_AGENT_MAX_LENGTH = 512;

type SubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function parseSubscription(payload: unknown): SubscriptionInput | null {
  const subscription = (payload as { subscription?: unknown })?.subscription;
  if (!subscription || typeof subscription !== "object") return null;
  const { endpoint, keys } = subscription as { endpoint?: unknown; keys?: unknown };
  const { p256dh, auth } = (keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return null;
  if (typeof p256dh !== "string" || !p256dh) return null;
  if (typeof auth !== "string" || !auth) return null;
  return { endpoint, p256dh, auth };
}

/**
 * 公開鍵と、このユーザーが登録済みの購読一覧。
 *
 * **公開鍵は環境変数から実行時に返す**（`NEXT_PUBLIC_`にしない）。ビルド時に埋め込むと、
 * 鍵を差し替えるたびにビルドし直すことになる。未設定なら`publicKey`はnullで、
 * 画面は「利用できません」を出す。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const vapid = getVapidConfig();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpointKey: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    { publicKey: vapid?.publicKey ?? null, subscriptions },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 購読を登録する。同じ宛先で登録し直したときは行を増やさず上書きする */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const subscription = parseSubscription(payload);
  if (!subscription) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
  const data = {
    userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    userAgent,
  };

  const saved = await db.pushSubscription.upsert({
    where: { endpointKey: pushEndpointKey(subscription.endpoint) },
    create: { ...data, endpointKey: pushEndpointKey(subscription.endpoint) },
    // 宛先が同じでもログインユーザーが変わることはある（同じ端末で別アカウント）。
    // その場合は持ち主を移す——古い持ち主へ送っても、届く先はこの端末のままなので
    update: data,
    select: { id: true, endpointKey: true, userAgent: true, createdAt: true },
  });

  return NextResponse.json({ ok: true, subscription: saved });
}

/**
 * 購読を解除する。`id`（設定画面の一覧から他の端末を外す）と
 * `endpoint`（この端末が自分を外す）のどちらでも指定できる。
 *
 * **消せるのは自分の購読だけ**（`userId`で絞る）。存在しないものを指定されても200を返す——
 * ブラウザ側で既に購読が捨てられている場合があり、そこで失敗にすると解除が完了できない。
 */
export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const id = (payload as { id?: unknown })?.id;
  const endpoint = (payload as { endpoint?: unknown })?.endpoint;

  if (typeof id === "string" && id) {
    await db.pushSubscription.deleteMany({ where: { id, userId } });
    return NextResponse.json({ ok: true });
  }
  if (typeof endpoint === "string" && endpoint) {
    await db.pushSubscription.deleteMany({
      where: { endpointKey: pushEndpointKey(endpoint), userId },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_request" }, { status: 400 });
}
