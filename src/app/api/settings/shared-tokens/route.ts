import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { generateSharedTokenValue } from "@/lib/shared-token-generate";
import { parseSharedTokenInput, toSharedToken } from "@/lib/shared-tokens";

const usages = { orderBy: { usedAt: "desc" as const } };

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db.sharedToken.findMany({ orderBy: { name: "asc" }, include: { usages } });
  return NextResponse.json({ sharedTokens: rows.map(toSharedToken) });
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
      include: { usages },
    });
    return NextResponse.json({
      sharedToken: toSharedToken(row),
      ...(generatedValue !== null ? { generatedValue } : {}),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}
