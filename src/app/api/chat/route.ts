import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { parseSearchQuery } from "@/lib/chat/session";
import { parseChatContext } from "@/lib/chat/store";
import type { ChatConversationStatus } from "@/lib/chat/types";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

const PAGE_SIZE = 50;

/**
 * 会話の一覧（更新が新しい順）。自分の会話だけが見える。
 * `q`: タイトル・本文・関連Issue/PR番号（`#3966`・`3966`）で検索。`archived`: `0`（既定）・`1`（アーカイブ済みだけ）・`all`
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const archived = params.get("archived");
  const { text, number } = parseSearchQuery(params.get("q") ?? "");

  const and: Prisma.ChatConversationWhereInput[] = [];
  if (archived === "1") and.push({ archivedAt: { not: null } });
  else if (archived !== "all") and.push({ archivedAt: null });
  if (text) {
    and.push({
      OR: [
        { title: { contains: text } },
        { messages: { some: { text: { contains: text } } } },
        ...(number != null ? [{ refsText: { contains: `#${number} ` } }] : []),
      ],
    });
  }

  const rows = await db.chatConversation.findMany({
    where: { userId, AND: and },
    orderBy: { updatedAt: "desc" },
    take: PAGE_SIZE,
    select: {
      id: true,
      title: true,
      repo: true,
      context: true,
      archivedAt: true,
      updatedAt: true,
      _count: { select: { messages: { where: { confirmState: "pending" } } } },
    },
  });
  return NextResponse.json(
    {
      conversations: rows.map((row) => {
        const context = parseChatContext(row.context);
        const status: ChatConversationStatus = row._count.messages > 0 ? "waiting" : "idle";
        return {
          id: row.id,
          title: row.title,
          repo: row.repo,
          targets: context.targets.map((t) => ({ repo: t.repo, number: t.number, kind: t.kind })),
          actionCount: context.actions.length,
          status,
          archived: row.archivedAt !== null,
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 新しい会話を作る（既存の会話は消さず、対象・合意・操作が混ざらない独立したセッション）。`repo`は番号だけの発言を補う既定のrepository */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: { repo?: unknown } = await request.json().catch(() => ({}));
  const repo = typeof body.repo === "string" && body.repo.includes("/") ? body.repo : null;
  if (repo && !(await findRepositoryByFullName(userId, repo))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const created = await db.chatConversation.create({
    data: { userId, title: "新しい会話", repo, context: { repo, targets: [], actions: [] }, memory: {} },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id });
}
