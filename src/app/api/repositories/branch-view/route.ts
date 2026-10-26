import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { isBranchViewMode } from "@/lib/branch-view-visibility";
import { db } from "@/lib/db";

/**
 * ブランチ画面でのリポジトリ表示の保存（#5087）。`always`は既定なので行を消す。
 * `HiddenRepository`（全体非表示）とは独立で、一覧の並べ方だけを変える。
 */
export async function PUT(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryId = payload?.repositoryId;
  const mode = payload?.mode;

  if (typeof repositoryId !== "string" || !repositoryId || !isBranchViewMode(mode)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      id: repositoryId,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (mode === "always") {
    await db.branchViewRepository.deleteMany({ where: { userId, repositoryId } });
  } else {
    await db.branchViewRepository.upsert({
      where: { userId_repositoryId: { userId, repositoryId } },
      create: { userId, repositoryId, mode },
      update: { mode },
    });
  }

  return NextResponse.json({ ok: true, mode });
}
