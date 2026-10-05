import type {
  ChatCard,
  ChatConfirmState,
  ChatContext,
  ChatInvestigation,
  ChatMessageView,
} from "@/lib/chat/types";
import { EMPTY_CHAT_CONTEXT } from "@/lib/chat/types";

/** DB（JSON列）から読んだ値を、型に合わない形が混ざっていても落ちない形へ整える */

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseInvestigation(value: unknown): ChatInvestigation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ChatInvestigation>;
  if (typeof raw.summary !== "string") return null;
  return {
    target: raw.target && typeof raw.target === "object" ? raw.target : null,
    summary: raw.summary,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    agreements: strings(raw.agreements),
    openQuestions: strings(raw.openQuestions),
    unconfirmed: strings(raw.unconfirmed),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function parseChatContext(value: unknown): ChatContext {
  if (!value || typeof value !== "object") return EMPTY_CHAT_CONTEXT;
  const raw = value as Partial<ChatContext>;
  return {
    repo: typeof raw.repo === "string" ? raw.repo : null,
    targets: Array.isArray(raw.targets) ? raw.targets : [],
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    investigation: parseInvestigation(raw.investigation),
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
