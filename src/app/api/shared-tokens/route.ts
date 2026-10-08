import { NextResponse, type NextRequest } from "next/server";

import { authorizeSharedTokenApi, authorizeProtectedSharedTokenWrite } from "@/lib/shared-token-auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { generateSharedTokenValue } from "@/lib/shared-token-generate";
import { canWriteSharedToken, parseSharedTokenConsumer, parseSharedTokenInput } from "@/lib/shared-tokens";

function authorize(request: NextRequest): NextResponse | null {
  const result = authorizeSharedTokenApi(request.headers.get("authorization"));
  if (result === "ok") return null;
  return NextResponse.json({ error: result }, { status: result === "not_configured" ? 503 : 401 });
}

function authorizeWrite(request: NextRequest, name: string): NextResponse | null {
  if (name !== "ISSUE_DECK_ACCESS_APP_TOKEN") return null;
  const result = authorizeProtectedSharedTokenWrite(request.headers.get("x-shared-token-write-authorization"));
  if (result === "ok") return null;
  return NextResponse.json(
    { error: result === "not_configured" ? "write_auth_not_configured" : "forbidden_write" },
    { status: result === "not_configured" ? 503 : 403 },
  );
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
  if (!canWriteSharedToken(input.name, consumer)) return NextResponse.json({ error: "forbidden_name" }, { status: 403 });
  const writeError = authorizeWrite(request, input.name);
  if (writeError) return writeError;

  // value省略時はissue-deckが生成する。生成した値は作成直後のこの応答でだけ返す（#4121）。
  const generatedValue = input.value === null ? generateSharedTokenValue() : null;
  const value = input.value ?? generatedValue!;

  try {
    const row = await db.sharedToken.create({
      data: {
        name: input.name,
        encryptedValue: encryptSecret(value),
        description: input.description,
        sourceReference: input.sourceReference,
        usages: { create: { consumer, action: "create" } },
      },
    });
    return NextResponse.json(
      { id: row.id, name: row.name, ...(generatedValue !== null ? { generatedValue } : {}) },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}

// 既存の値を名前で上書きする（無ければ作る）。再発行で旧トークンが即失効するアプリ向け。
// 説明・移行元は指定があるときだけ更新し、省略時は既存の値を保つ。
export async function PUT(request: NextRequest) {
  const authError = authorize(request);
  if (authError) return authError;
  const consumer = getConsumer(request);
  if (!consumer) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const input = parseSharedTokenInput(await request.json().catch(() => null));
  // 上書きは外部で決まった新しい値を差し替える経路なので、値の省略（自動生成）は受け付けない
  if (!input || input.value === null) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (!canWriteSharedToken(input.name, consumer)) return NextResponse.json({ error: "forbidden_name" }, { status: 403 });
  const writeError = authorizeWrite(request, input.name);
  if (writeError) return writeError;

  const encryptedValue = encryptSecret(input.value);
  const existing = await db.sharedToken.findUnique({ where: { name: input.name } });
  if (existing) {
    const row = await db.sharedToken.update({
      where: { id: existing.id },
      data: {
        encryptedValue,
        ...(input.description !== null ? { description: input.description } : {}),
        ...(input.sourceReference !== null ? { sourceReference: input.sourceReference } : {}),
        usages: { create: { consumer, action: "update" } },
      },
    });
    return NextResponse.json({ id: row.id, name: row.name }, { status: 200 });
  }

  try {
    const row = await db.sharedToken.create({
      data: {
        name: input.name,
        encryptedValue,
        description: input.description,
        sourceReference: input.sourceReference,
        usages: { create: { consumer, action: "create" } },
      },
    });
    return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
  } catch (error) {
    // 同時に別の書き込みが先に作成した場合は、409ではなく上書き側へ倒す
    if (isUniqueConstraintError(error)) {
      const row = await db.sharedToken.update({
        where: { name: input.name },
        data: { encryptedValue, usages: { create: { consumer, action: "update" } } },
      });
      return NextResponse.json({ id: row.id, name: row.name }, { status: 200 });
    }
    throw error;
  }
}
