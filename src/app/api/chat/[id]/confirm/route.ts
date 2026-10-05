import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { executeConfirmedCard, withAction } from "@/lib/chat/handlers";
import { parseChatContext, toChatMessageView } from "@/lib/chat/store";
import type { ChatConfirmCard } from "@/lib/chat/types";
import { db } from "@/lib/db";
import { previewModeGuard } from "@/lib/preview-mode";

type Params = { params: Promise<{ id: string }> };

/**
 * 確認カードの「実行する」「やめる」。副作用のある操作が走る**唯一の入口**。
 * 実行するカードの内容はクライアントの申告ではなく、保存済みの発言から読む。
 * `pending`→`done`へ更新できた1回だけが実行し、二重クリックや再送で2回走らない。
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body: { messageId?: unknown; action?: unknown; title?: unknown; body?: unknown } = await request
    .json()
    .catch(() => ({}));
  if (typeof body.messageId !== "string" || (body.action !== "execute" && body.action !== "cancel")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (body.action === "execute") {
    const guard = previewModeGuard();
    if (guard) return guard;
  }

  const message = await db.chatMessage.findFirst({
    where: { id: body.messageId, conversationId: id, conversation: { userId: user.id } },
    include: { conversation: true },
  });
  if (!message || message.confirmState === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const claimed = await db.chatMessage.updateMany({
    where: { id: message.id, confirmState: "pending" },
    data: { confirmState: body.action === "execute" ? "done" : "cancelled" },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "already_resolved" }, { status: 409 });
  }

  if (body.action === "cancel") {
    const reply = await db.chatMessage.create({
      data: { conversationId: id, role: "assistant", text: "やめました。何も実行していません。" },
    });
    return NextResponse.json({ confirmState: "cancelled", messages: [toChatMessageView(reply)] });
  }

  const card = (Array.isArray(message.cards) ? message.cards : []).find(
    (item): item is ChatConfirmCard =>
      !!item &&
      typeof item === "object" &&
      ((item as { type?: unknown }).type === "confirm_repair" ||
        (item as { type?: unknown }).type === "confirm_issue"),
  );
  if (!card) {
    await db.chatMessage.update({ where: { id: message.id }, data: { confirmState: "pending" } });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const outcome = await executeConfirmedCard(user, card, {
    title: typeof body.title === "string" ? body.title : undefined,
    body: typeof body.body === "string" ? body.body : undefined,
  });
  // 失敗したときは押し直せるよう`pending`へ戻す（成功した場合だけ`done`のまま残す）
  if (!outcome.ok) {
    await db.chatMessage.update({ where: { id: message.id }, data: { confirmState: "pending" } });
  }
  const context = withAction(parseChatContext(message.conversation.context), outcome.action);
  const [reply] = await db.$transaction([
    db.chatMessage.create({
      data: {
        conversationId: id,
        role: "assistant",
        text: outcome.text,
        cards: JSON.parse(JSON.stringify([outcome.card])),
      },
    }),
    db.chatConversation.update({
      where: { id },
      data: { context: JSON.parse(JSON.stringify(context)) },
    }),
  ]);
  return NextResponse.json({
    confirmState: outcome.ok ? "done" : "pending",
    ok: outcome.ok,
    messages: [toChatMessageView(reply)],
    context,
  });
}
