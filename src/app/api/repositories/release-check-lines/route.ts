import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * リリース本文の箇条書き1行（1機能）ぶんの「確認した」記録のON/OFF（#2982）。
 *
 * `POST`で確認済みにし、`DELETE`で未確認へ戻す（`release-checks/route.ts`と同じ形）。
 * リリース1件全体の確認フラグ（`ReleaseCheck`）とは独立していて、こちらの記録の有無は
 * 「確認済みにする」ボタンの状態に影響しない。
 */

/** GitHubのref名の上限に合わせた保険。長すぎる値でDBのカラムを溢れさせない */
const MAX_TAG_NAME_LENGTH = 255;

async function resolveRepository(userId: string, repoFullName: string) {
  return db.repository.findFirst({
    where: {
      fullName: repoFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
}

type ParsedBody = { repoFullName: string; tagName: string; lineIndex: number };

async function parseBody(request: NextRequest): Promise<ParsedBody | null> {
  const payload = await request.json().catch(() => null);
  const repoFullName = payload?.repoFullName;
  const tagName = payload?.tagName;
  const lineIndex = payload?.lineIndex;

  if (typeof repoFullName !== "string" || !repoFullName) return null;
  if (typeof tagName !== "string" || !tagName || tagName.length > MAX_TAG_NAME_LENGTH) return null;
  if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex) || lineIndex < 0) return null;

  return { repoFullName, tagName, lineIndex };
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await parseBody(request);
  if (!body) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await resolveRepository(userId, body.repoFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const checked = await db.releaseCheckLine.upsert({
    where: {
      userId_repositoryId_tagName_lineIndex: {
        userId,
        repositoryId: repository.id,
        tagName: body.tagName,
        lineIndex: body.lineIndex,
      },
    },
    create: { userId, repositoryId: repository.id, tagName: body.tagName, lineIndex: body.lineIndex },
    update: {},
  });

  return NextResponse.json({ ok: true, checkedAt: checked.checkedAt.toISOString() });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await parseBody(request);
  if (!body) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await resolveRepository(userId, body.repoFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.releaseCheckLine.deleteMany({
    where: { userId, repositoryId: repository.id, tagName: body.tagName, lineIndex: body.lineIndex },
  });

  return NextResponse.json({ ok: true });
}
