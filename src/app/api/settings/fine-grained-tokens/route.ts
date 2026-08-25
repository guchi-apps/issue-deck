import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseFineGrainedTokenInput, toFineGrainedToken } from "@/lib/fine-grained-tokens";
import { isUniqueConstraintError } from "@/lib/prisma-error";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db.fineGrainedToken.findMany({ orderBy: { expiresAt: "asc" } });
  return NextResponse.json({ fineGrainedTokens: rows.map(toFineGrainedToken) });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const input = parseFineGrainedTokenInput(payload);
  if (!input) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const row = await db.fineGrainedToken.create({
      data: { name: input.name, expiresAt: input.expiresAt },
    });
    return NextResponse.json({ fineGrainedToken: toFineGrainedToken(row) });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}
