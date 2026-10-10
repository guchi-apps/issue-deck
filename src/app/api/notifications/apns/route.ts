import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { APNS_DEVICE_TOKEN_PATTERN, apnsEndpoint } from "@/lib/notifications/apns";
import { pushEndpointKey } from "@/lib/notifications/push";

/**
 * iOSアプリ（APNs。#4250）の端末トークンの登録・解除。
 *
 * 宛先は`PushSubscription`へ`endpoint = "apns:<トークン>"`で保存し、Web Pushと同じ
 * 設定画面の一覧・ミュート・解除がそのまま効く。暗号鍵（`p256dh`・`auth`）はAPNsでは
 * 不要なので空文字を入れる。消せるのは自分の購読だけ。
 */

const USER_AGENT_MAX_LENGTH = 512;

function parseToken(payload: unknown): string | null {
  const token = (payload as { deviceToken?: unknown })?.deviceToken;
  if (typeof token !== "string" || !APNS_DEVICE_TOKEN_PATTERN.test(token)) return null;
  return token.toLowerCase();
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = parseToken(await request.json().catch(() => null));
  if (!token) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const endpoint = apnsEndpoint(token);
  const data = {
    userId,
    endpoint,
    p256dh: "",
    auth: "",
    userAgent: request.headers.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
  };
  const saved = await db.pushSubscription.upsert({
    where: { endpointKey: pushEndpointKey(endpoint) },
    create: { ...data, endpointKey: pushEndpointKey(endpoint) },
    // 同じ端末で別アカウントでログインし直したときは持ち主を移す（Web Pushと同じ）
    update: data,
    select: { id: true, endpointKey: true },
  });
  return NextResponse.json({ ok: true, subscription: saved });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = parseToken(await request.json().catch(() => null));
  if (!token) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  await db.pushSubscription.deleteMany({
    where: { endpointKey: pushEndpointKey(apnsEndpoint(token)), userId },
  });
  return NextResponse.json({ ok: true });
}
