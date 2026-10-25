import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { parseExpectedConsumers } from "@/lib/shared-tokens";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const row = await db.sharedToken.findUnique({ where: { id }, select: { encryptedValue: true } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ value: decryptSecret(row.encryptedValue) });
}

/** 想定される利用元を更新する（#4998）。空配列で未設定（検知の対象外）に戻す */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { expectedConsumers?: unknown } | null;
  const expectedConsumers = parseExpectedConsumers(body?.expectedConsumers);
  if (!expectedConsumers) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { id } = await params;
  const { count } = await db.sharedToken.updateMany({
    where: { id },
    data: { expectedConsumers: expectedConsumers.length > 0 ? expectedConsumers : Prisma.DbNull },
  });
  if (count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ expectedConsumers });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  await db.sharedToken.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
