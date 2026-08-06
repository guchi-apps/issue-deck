import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function findRepository(userId: string, repositoryId: string) {
  return db.repository.findFirst({
    where: {
      id: repositoryId,
      installation: { userInstallations: { some: { userId } } },
    },
  });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryId = payload?.repositoryId;

  if (typeof repositoryId !== "string" || !repositoryId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, repositoryId);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.favoriteRepository.upsert({
    where: { userId_repositoryId: { userId, repositoryId } },
    create: { userId, repositoryId },
    update: {},
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryId = payload?.repositoryId;

  if (typeof repositoryId !== "string" || !repositoryId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  await db.favoriteRepository.deleteMany({ where: { userId, repositoryId } });

  return NextResponse.json({ ok: true });
}
