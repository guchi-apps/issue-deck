import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * 「リリース後の動作確認を追う」対象リポジトリのON/OFF（#2930）。
 *
 * `POST`で対象に加え、`DELETE`で外す（`repositories/hidden`と同じ形）。
 *
 * **対象に加えた時刻（`createdAt`）が「いつからのリリースを見るか」の基準になる。**
 * そのため`POST`は`upsert`で既存行の時刻を書き換えず、**すでに対象なら何もしない**——
 * 押し直すたびに基準が今へ動くと、未確認のまま残っていたリリースが黙って対象外になる。
 * 一度外して入れ直したときだけ基準が動く（そのときは意図した操作とみなす）。
 */

async function findRepository(userId: string, repositoryId: string) {
  return db.repository.findFirst({
    where: {
      id: repositoryId,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
}

async function parseRepositoryId(request: NextRequest): Promise<string | null> {
  const payload = await request.json().catch(() => null);
  const repositoryId = payload?.repositoryId;
  return typeof repositoryId === "string" && repositoryId ? repositoryId : null;
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositoryId = await parseRepositoryId(request);
  if (!repositoryId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, repositoryId);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const target = await db.releaseCheckTarget.upsert({
    where: { userId_repositoryId: { userId, repositoryId } },
    create: { userId, repositoryId },
    update: {},
  });

  return NextResponse.json({ ok: true, since: target.createdAt.toISOString() });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositoryId = await parseRepositoryId(request);
  if (!repositoryId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 確認済みの記録は消さない。また対象へ戻したときに、確認した事実まで失われるのを避ける
  // （対象外のあいだは表示側が「対象外」として扱うため、残っていても画面には出ない）。
  await db.releaseCheckTarget.deleteMany({ where: { userId, repositoryId } });

  return NextResponse.json({ ok: true });
}
