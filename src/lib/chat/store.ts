import type { ChatCard, ChatConfirmState, ChatContext, ChatMessageView } from "@/lib/chat/types";
import { EMPTY_CHAT_CONTEXT } from "@/lib/chat/types";

/** DB（JSON列）から読んだ値を、型に合わない形が混ざっていても落ちない形へ整える */

export function parseChatContext(value: unknown): ChatContext {
  if (!value || typeof value !== "object") return EMPTY_CHAT_CONTEXT;
  const raw = value as Partial<ChatContext>;
  return {
    repo: typeof raw.repo === "string" ? raw.repo : null,
    targets: Array.isArray(raw.targets) ? raw.targets : [],
    actions: Array.isArray(raw.actions) ? raw.actions : [],
  };
}

function parseConfirmState(value: string | null): ChatConfirmState | null {
  return value === "pending" || value === "done" || value === "cancelled" ? value : null;
}

export function toChatMessageView(row: {
  id: string;
  role: string;
  text: string;
  cards: unknown;
  confirmState: string | null;
  createdAt: Date;
}): ChatMessageView {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    text: row.text,
    cards: Array.isArray(row.cards) ? (row.cards as ChatCard[]) : [],
    confirmState: parseConfirmState(row.confirmState),
    createdAt: row.createdAt.toISOString(),
  };
}

export function conversationTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine || "新しい会話";
}
