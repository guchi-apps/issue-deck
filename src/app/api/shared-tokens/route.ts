import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedTokenApi } from "@/lib/shared-token-auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { parseSharedTokenConsumer, parseSharedTokenInput } from "@/lib/shared-tokens";

function authorize(request: NextRequest): NextResponse | null {
  const result = authorizeSharedTokenApi(request.headers.get("authorization"));
  if (result === "ok") return null;
  return NextResponse.json({ error: result }, { status: result === "not_configured" ? 503 : 401 });
}

function getConsumer(request: NextRequest): string | null {
  return parseSharedTokenConsumer(request.headers.get("x-shared-token-consumer"));
}

export async function GET(request: NextRequest) {
  const authError = authorize(request);
  if (authError) return authError;
  const consumer = getConsumer(request);
  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!consumer || !name) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const row = await db.sharedToken.findUnique({ where: { name } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.sharedTokenUsage.create({ data: { sharedTokenId: row.id, consumer, action: "read" } });
  return NextResponse.json({ name: row.name, value: decryptSecret(row.encryptedValue) });
}

export async function POST(request: NextRequest) {
  const authError = authorize(request);
  if (authError) return authError;
  const consumer = getConsumer(request);
  if (!consumer) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const input = parseSharedTokenInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const row = await db.sharedToken.create({
      data: {
        name: input.name,
        encryptedValue: encryptSecret(input.value),
        description: input.description,
        sourceReference: input.sourceReference,
        usages: { create: { consumer, action: "create" } },
      },
    });
    return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}
