import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { handleChatMessage } from "@/lib/chat/handlers";
import { conversationTitle, parseChatContext, toChatMessageView } from "@/lib/chat/store";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

const MAX_TEXT_LENGTH = 2000;
/** Issue案の材料にする、直近の自分の発言の件数 */
const RECENT_USER_TEXTS = 8;

export async function GET(_request: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const conversation = await db.chatConversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" }, take: 200 } },
  });
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    {
      id: conversation.id,
      title: conversation.title,
      context: parseChatContext(conversation.context),
      messages: conversation.messages.map(toChatMessageView),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 発言を送る。読み取り（状態確認）はここで実行して返す。副作用のある操作（PR自動修正・Issue作成）は
 * 確認カードを返すだけで、実行は`/confirm`を通る（Chatから確認を迂回できない）。
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body: { text?: unknown } = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const conversation = await db.chatConversation.findFirst({ where: { id, userId: user.id } });
  if (!conversation) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const recent = await db.chatMessage.findMany({
    where: { conversationId: id, role: "user" },
    orderBy: { createdAt: "desc" },
    take: RECENT_USER_TEXTS,
    select: { text: true },
  });
  const reply = await handleChatMessage({
    user,
    context: parseChatContext(conversation.context),
    text,
    recentUserTexts: [...recent.map((row) => row.text).reverse(), text],
  });

  const [userMessage, assistantMessage] = await db.$transaction([
    db.chatMessage.create({ data: { conversationId: id, role: "user", text } }),
    db.chatMessage.create({
      data: {
        conversationId: id,
        role: "assistant",
        text: reply.text,
        cards: JSON.parse(JSON.stringify(reply.cards)),
        confirmState: reply.needsConfirm ? "pending" : null,
      },
    }),
    db.chatConversation.update({
      where: { id },
      data: {
        context: JSON.parse(JSON.stringify(reply.nextContext)),
        repo: reply.nextContext.repo,
        ...(conversation.title === "新しい会話" ? { title: conversationTitle(text) } : {}),
      },
    }),
  ]);

  return NextResponse.json({
    messages: [toChatMessageView(userMessage), toChatMessageView(assistantMessage)],
    context: reply.nextContext,
  });
}
