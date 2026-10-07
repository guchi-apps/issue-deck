import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { isPushKind, PUSH_KINDS, type PushKind } from "@/lib/notifications/push-kinds";

/**
 * Push通知の種類ごとのON/OFF（#4159）。**ユーザー単位**で、端末（購読）ごとではない。
 * `PushMutedKind`に行があればOFF。レスポンスは全種類の`{ kind: 有効か }`。
 */

async function loadEnabled(userId: string): Promise<Record<PushKind, boolean>> {
  const muted = await db.pushMutedKind.findMany({ where: { userId }, select: { kind: true } });
  const mutedSet = new Set(muted.map((row) => row.kind));
  return Object.fromEntries(PUSH_KINDS.map((kind) => [kind, !mutedSet.has(kind)])) as Record<
    PushKind,
    boolean
  >;
}

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    { enabled: await loadEnabled(userId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 本文は`{ kind, enabled }`。未知の種類は400 */
export async function PUT(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    kind?: unknown;
    enabled?: unknown;
  } | null;
  if (!body || !isPushKind(body.kind) || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (body.enabled) {
    await db.pushMutedKind.deleteMany({ where: { userId, kind: body.kind } });
  } else {
    await db.pushMutedKind.upsert({
      where: { userId_kind: { userId, kind: body.kind } },
      create: { userId, kind: body.kind },
      update: {},
    });
  }
  return NextResponse.json({ enabled: await loadEnabled(userId) });
}
