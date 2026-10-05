import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { hasConversationRepoAccess } from "@/lib/chat/access";
import { handleChatMessage } from "@/lib/chat/handlers";
import { refreshConversation } from "@/lib/chat/resume";
import {
  applyMemoryOp,
  buildRefsText,
  parseChatMemory,
  recordFindings,
  type ChatMemoryOp,
} from "@/lib/chat/session";
import { conversationTitle, parseChatContext, toChatMessageView } from "@/lib/chat/store";
import type { ChatConfirmCard, ChatStatusCard } from "@/lib/chat/types";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

const MAX_TEXT_LENGTH = 2000;
const MAX_TITLE_LENGTH = 120;
/** Issue案の材料にする、直近の自分の発言の件数 */
const RECENT_USER_TEXTS = 8;
/** 1回の取得で返す発言の件数。これより古い分は`before`で遡る */
const PAGE_SIZE = 100;
/** 他端末の更新と衝突したときに、読み直してやり直す回数 */
const MAX_RETRIES = 3;

class VersionConflict extends Error {}

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

/**
 * 会話を開く。発言は新しい側から`PAGE_SIZE`件（`before`に発言IDを渡すとそれより古い分）。
 * `refresh=1`ではGitHub上の現在の状態を取り直し、調査時点との差と、確認待ちカードがいま有効かを返す。
 */
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const search = request.nextUrl.searchParams;
  const before = search.get("before");

  const conversation = await db.chatConversation.findFirst({ where: { id, userId: user.id } });
  if (!conversation) return json({ error: "not_found" }, { status: 404 });

  let cursor: Date | null = null;
  if (before) {
    const anchor = await db.chatMessage.findFirst({
      where: { id: before, conversationId: id },
      select: { createdAt: true },
    });
    if (!anchor) return json({ error: "not_found" }, { status: 404 });
    cursor = anchor.createdAt;
  }
  const rows = await db.chatMessage.findMany({
    where: { conversationId: id, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const messages = rows.slice(0, PAGE_SIZE).reverse();

  const context = parseChatContext(conversation.context);
  const memory = parseChatMemory(conversation.memory);
  const accessible = await hasConversationRepoAccess(user.id, conversation.repo);

  let freshness: Awaited<ReturnType<typeof refreshConversation>> | null = null;
  if (search.get("refresh") === "1" && !before && accessible) {
    const pending = await db.chatMessage.findMany({
      where: { conversationId: id, confirmState: "pending" },
      select: { id: true, cards: true },
    });
    const pendingConfirms = pending.flatMap((row) =>
      (Array.isArray(row.cards) ? row.cards : [])
        .filter(
          (card): card is ChatConfirmCard =>
            !!card && typeof card === "object" && String((card as { type?: unknown }).type).startsWith("confirm_"),
        )
        .map((card) => ({ messageId: row.id, card })),
    );
    freshness = await refreshConversation({ user, context, memory, pendingConfirms });
  }

  return json({
    id: conversation.id,
    title: conversation.title,
    repo: conversation.repo,
    archived: conversation.archivedAt !== null,
    version: conversation.version,
    accessible,
    context,
    memory,
    messages: messages.map(toChatMessageView),
    hasMore,
    freshness: freshness?.freshness ?? null,
    staleConfirms: freshness?.staleConfirms ?? [],
  });
}

/**
 * 発言を送る。読み取り（状態確認）はここで実行して返す。副作用のある操作（PR自動修正・Issue作成）は
 * 確認カードを返すだけで、実行は`/confirm`を通る（Chatから確認を迂回できない）。
 *
 * `clientMessageId`は再送・複数端末の重複送信で二重登録しないための冪等キー。同じIDの発言が保存済みなら、
 * 何も実行せず保存済みの返信を返す。保存は会話の`version`を条件にし、他端末の更新と衝突したら読み直してやり直す。
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body: { text?: unknown; clientMessageId?: unknown } = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const clientMessageId =
    typeof body.clientMessageId === "string" && /^[\w-]{8,64}$/.test(body.clientMessageId)
      ? body.clientMessageId
      : null;
  if (!text || text.length > MAX_TEXT_LENGTH) return json({ error: "invalid_request" }, { status: 400 });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const conversation = await db.chatConversation.findFirst({ where: { id, userId: user.id } });
    if (!conversation) return json({ error: "not_found" }, { status: 404 });

    if (clientMessageId) {
      const existing = await db.chatMessage.findUnique({
        where: { conversationId_clientMessageId: { conversationId: id, clientMessageId } },
      });
      if (existing) {
        const reply = await db.chatMessage.findFirst({
          where: { conversationId: id, role: "assistant", createdAt: { gte: existing.createdAt } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return json({
          duplicate: true,
          messages: [toChatMessageView(existing), ...(reply ? [toChatMessageView(reply)] : [])],
          context: parseChatContext(conversation.context),
        });
      }
    }
    if (!(await hasConversationRepoAccess(user.id, conversation.repo))) {
      return json({ error: "repository_access_lost" }, { status: 403 });
    }

    const context = parseChatContext(conversation.context);
    const recent = await db.chatMessage.findMany({
      where: { conversationId: id, role: "user" },
      orderBy: { createdAt: "desc" },
      take: RECENT_USER_TEXTS,
      select: { text: true },
    });
    const reply = await handleChatMessage({
      user,
      context,
      text,
      recentUserTexts: [...recent.map((row) => row.text).reverse(), text],
    });
    const memory = recordFindings(
      parseChatMemory(conversation.memory),
      reply.cards.filter((card): card is ChatStatusCard => card.type === "status"),
      new Date(),
    );

    try {
      const [userMessage, assistantMessage] = await db.$transaction(async (tx) => {
        const updated = await tx.chatConversation.updateMany({
          where: { id, version: conversation.version },
          data: {
            context: JSON.parse(JSON.stringify(reply.nextContext)),
            memory: JSON.parse(JSON.stringify(memory)),
            refsText: buildRefsText(reply.nextContext, [text], conversation.refsText),
            repo: reply.nextContext.repo,
            version: { increment: 1 },
            ...(conversation.title === "新しい会話" ? { title: conversationTitle(text) } : {}),
          },
        });
        if (updated.count !== 1) throw new VersionConflict();
        const userRow = await tx.chatMessage.create({
          data: { conversationId: id, role: "user", text, clientMessageId },
        });
        const assistantRow = await tx.chatMessage.create({
          data: {
            conversationId: id,
            role: "assistant",
            text: reply.text,
            cards: JSON.parse(JSON.stringify(reply.cards)),
            confirmState: reply.needsConfirm ? "pending" : null,
          },
        });
        return [userRow, assistantRow];
      });
      return json({
        messages: [toChatMessageView(userMessage), toChatMessageView(assistantMessage)],
        context: reply.nextContext,
        memory,
      });
    } catch (error) {
      // 他端末の更新との衝突、または同じ`clientMessageId`の同時送信。読み直してやり直せば、前者は最新の
      // 文脈で返信を作り直し、後者は保存済みの返信を返す
      const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (error instanceof VersionConflict || duplicate) continue;
      throw error;
    }
  }
  return json({ error: "conflict" }, { status: 409 });
}

/** 名前変更・アーカイブ／解除・会話メモ（合意・未解決の質問）の更新。アーカイブは削除でも実行停止でもない */
export async function PATCH(request: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (!userId) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body: { title?: unknown; archived?: unknown; memoryOp?: unknown } = await request
    .json()
    .catch(() => ({}));

  const data: Prisma.ChatConversationUpdateManyMutationInput = {};
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > MAX_TITLE_LENGTH) return json({ error: "invalid_request" }, { status: 400 });
    data.title = title;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") return json({ error: "invalid_request" }, { status: 400 });
    data.archivedAt = body.archived ? new Date() : null;
  }
  const op = body.memoryOp as ChatMemoryOp | undefined;
  if (op !== undefined && (typeof op !== "object" || op === null || typeof (op as { op?: unknown }).op !== "string")) {
    return json({ error: "invalid_request" }, { status: 400 });
  }
  if (Object.keys(data).length === 0 && !op) return json({ error: "invalid_request" }, { status: 400 });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const conversation = await db.chatConversation.findFirst({ where: { id, userId } });
    if (!conversation) return json({ error: "not_found" }, { status: 404 });
    const patch: Prisma.ChatConversationUpdateManyMutationInput = { ...data };
    let memory = parseChatMemory(conversation.memory);
    if (op) {
      const next = applyMemoryOp(memory, op, new Date(), () => crypto.randomUUID());
      if (!next) return json({ error: "invalid_request" }, { status: 400 });
      memory = next;
      patch.memory = JSON.parse(JSON.stringify(next));
    }
    const updated = await db.chatConversation.updateMany({
      where: { id, userId, version: conversation.version },
      data: { ...patch, version: { increment: 1 } },
    });
    if (updated.count === 1) {
      return json({
        title: typeof data.title === "string" ? data.title : conversation.title,
        archived: data.archivedAt === undefined ? conversation.archivedAt !== null : data.archivedAt !== null,
        memory,
        version: conversation.version + 1,
      });
    }
  }
  return json({ error: "conflict" }, { status: 409 });
}
