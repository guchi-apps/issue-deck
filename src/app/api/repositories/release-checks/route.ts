import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * リリース1件ぶんの「動作確認が済んだ」記録のON/OFF（#2930）。
 *
 * `POST`で確認済みにし、`DELETE`で未確認へ戻す（`repositories/hidden`と同じ形）。
 * **対象リポジトリかどうかはここでは見ない**——対象の判定は表示側の純粋関数
 * （`lib/release-check.ts`）が行い、こちらは記録の有無だけを扱う。対象から外した
 * リポジトリの記録が残っていても、画面は「対象外」として扱う。
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

type ParsedBody = { repoFullName: string; tagName: string };

async function parseBody(request: NextRequest): Promise<ParsedBody | null> {
  const payload = await request.json().catch(() => null);
  const repoFullName = payload?.repoFullName;
  const tagName = payload?.tagName;

  if (typeof repoFullName !== "string" || !repoFullName) return null;
  if (typeof tagName !== "string" || !tagName || tagName.length > MAX_TAG_NAME_LENGTH) return null;

  return { repoFullName, tagName };
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

  const checked = await db.releaseCheck.upsert({
    where: {
      userId_repositoryId_tagName: {
        userId,
        repositoryId: repository.id,
        tagName: body.tagName,
      },
    },
    create: { userId, repositoryId: repository.id, tagName: body.tagName },
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

  await db.releaseCheck.deleteMany({
    where: { userId, repositoryId: repository.id, tagName: body.tagName },
  });

  return NextResponse.json({ ok: true });
}
