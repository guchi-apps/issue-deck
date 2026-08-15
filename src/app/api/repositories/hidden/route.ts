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

/** 渡されたIDのうち、そのユーザーが連携しているリポジトリのものだけに絞る */
async function filterOwnedRepositoryIds(userId: string, repositoryIds: string[]) {
  const owned = await db.repository.findMany({
    where: {
      id: { in: repositoryIds },
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  return owned.map((repository) => repository.id);
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

  await db.hiddenRepository.upsert({
    where: { userId_repositoryId: { userId, repositoryId } },
    create: { userId, repositoryId },
    update: {},
  });

  return NextResponse.json({ ok: true });
}

/**
 * 複数まとめて表示・非表示を切り替える（#1552。設定画面の「すべて表示」「すべて非表示」）。
 *
 * 1件ずつのトグルは`POST`/`DELETE`のままで、こちらは一括操作専用。**渡されたIDは必ず
 * `filterOwnedRepositoryIds`で自分の連携ぶんに絞ってから書く**（他人のリポジトリIDを混ぜて
 * 送られても、その行を作らない）。
 */
export async function PUT(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryIds = payload?.repositoryIds;
  const hidden = payload?.hidden;

  if (
    !Array.isArray(repositoryIds) ||
    repositoryIds.some((id) => typeof id !== "string" || !id) ||
    typeof hidden !== "boolean"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const ownedIds = await filterOwnedRepositoryIds(userId, repositoryIds as string[]);

  if (hidden) {
    await db.hiddenRepository.createMany({
      data: ownedIds.map((repositoryId) => ({ userId, repositoryId })),
      skipDuplicates: true,
    });
  } else {
    await db.hiddenRepository.deleteMany({ where: { userId, repositoryId: { in: ownedIds } } });
  }

  return NextResponse.json({ ok: true, updated: ownedIds.length });
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

  await db.hiddenRepository.deleteMany({ where: { userId, repositoryId } });

  return NextResponse.json({ ok: true });
}
