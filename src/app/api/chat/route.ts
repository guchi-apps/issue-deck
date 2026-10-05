import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { db } from "@/lib/db";

/** 会話の一覧（新しい順）。履歴は自分の会話だけが見える */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db.chatConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, repo: true, updatedAt: true },
  });
  return NextResponse.json(
    {
      conversations: rows.map((row) => ({
        id: row.id,
        title: row.title,
        repo: row.repo,
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 新しい会話を作る。`repo`は番号だけが書かれたときに補う既定のrepository */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: { repo?: unknown } = await request.json().catch(() => ({}));
  const repo = typeof body.repo === "string" && body.repo.includes("/") ? body.repo : null;
  if (repo && !(await findRepositoryByFullName(userId, repo))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const created = await db.chatConversation.create({
    data: { userId, title: "新しい会話", repo, context: { repo, targets: [], actions: [] } },
    select: { id: true },
  });
  return NextResponse.json({ id: created.id });
}
