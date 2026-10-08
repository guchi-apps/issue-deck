import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { generateSharedTokenValue } from "@/lib/shared-token-generate";
import { parseSharedTokenInput, toSharedToken, type SharedTokenUsageSummary } from "@/lib/shared-tokens";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 利用記録は増え続けるので全行を読まず、トークン×利用元ごとの最終利用日時だけを集計で取る（#4165）
  const [rows, grouped] = await Promise.all([
    db.sharedToken.findMany({ orderBy: { name: "asc" } }),
    db.sharedTokenUsage.groupBy({ by: ["sharedTokenId", "consumer"], _max: { usedAt: true } }),
  ]);
  const usagesByToken = new Map<string, SharedTokenUsageSummary[]>();
  for (const group of grouped) {
    if (!group._max.usedAt) continue;
    const list = usagesByToken.get(group.sharedTokenId) ?? [];
    list.push({ consumer: group.consumer, usedAt: group._max.usedAt });
    usagesByToken.set(group.sharedTokenId, list);
  }
  return NextResponse.json({
    sharedTokens: rows.map((row) => toSharedToken({ ...row, usages: usagesByToken.get(row.id) ?? [] })),
  });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = parseSharedTokenInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const generatedValue = input.value === null ? generateSharedTokenValue() : null;
  const value = input.value ?? generatedValue!;

  try {
    const row = await db.sharedToken.create({
      data: {
        name: input.name,
        encryptedValue: encryptSecret(value),
        description: input.description,
        sourceReference: input.sourceReference,
      },
    });
    return NextResponse.json({
      sharedToken: toSharedToken({ ...row, usages: [] }),
      ...(generatedValue !== null ? { generatedValue } : {}),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}
