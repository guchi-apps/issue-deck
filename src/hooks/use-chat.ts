"use client";

import { useCallback, useEffect, useState } from "react";

import type { ChatContext, ChatMessageView } from "@/lib/chat/types";

export type ChatConversationSummary = {
  id: string;
  title: string;
  repo: string | null;
  updatedAt: string;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!response.ok || !json) {
    const reason = json?.message ?? json?.error ?? String(response.status);
    throw new Error(reason === "preview_mode_forbidden" ? "この環境では実行できません（プレビュー環境）。" : reason);
  }
  return json;
}

/** IssueDeck Chatの会話一覧と、開いている会話の発言（#3975） */
export function useChat(active: boolean) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const json = await requestJson<{ conversations: ChatConversationSummary[] }>("/api/chat");
      setConversations(json.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "会話の一覧を読み込めませんでした。");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void requestJson<{ conversations: ChatConversationSummary[] }>("/api/chat")
      .then((json) => {
        if (!cancelled) setConversations(json.conversations);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "会話の一覧を読み込めませんでした。");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      const json = await requestJson<{ id: string; context: ChatContext; messages: ChatMessageView[] }>(
        `/api/chat/${id}`,
      );
      setConversationId(json.id);
      setMessages(json.messages);
      setContext(json.context);
    } catch (e) {
      setError(e instanceof Error ? e.message : "会話を開けませんでした。");
    }
  }, []);

  const startNew = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setContext(null);
    setError(null);
  }, []);

  const send = useCallback(
    async (text: string, repo: string | null) => {
      const body = text.trim();
      if (!body || isSending) return;
      setIsSending(true);
      setError(null);
      try {
        let id = conversationId;
        if (!id) {
          const created = await requestJson<{ id: string }>("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo }),
          });
          id = created.id;
          setConversationId(id);
        }
        const json = await requestJson<{ messages: ChatMessageView[]; context: ChatContext }>(
          `/api/chat/${id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: body }),
          },
        );
        setMessages((current) => [...current, ...json.messages]);
        setContext(json.context);
        void refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : "送信できませんでした。");
      } finally {
        setIsSending(false);
      }
    },
    [conversationId, isSending, refreshList],
  );

  const resolveConfirm = useCallback(
    async (
      messageId: string,
      action: "execute" | "cancel",
      overrides?: { title?: string; body?: string },
    ) => {
      if (!conversationId || isSending) return;
      setIsSending(true);
      setError(null);
      try {
        const json = await requestJson<{
          confirmState: "done" | "cancelled" | "pending";
          messages: ChatMessageView[];
          context?: ChatContext;
        }>(`/api/chat/${conversationId}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, action, ...overrides }),
        });
        setMessages((current) => [
          ...current.map((message) =>
            message.id === messageId ? { ...message, confirmState: json.confirmState } : message,
          ),
          ...json.messages,
        ]);
        if (json.context) setContext(json.context);
      } catch (e) {
        setError(e instanceof Error ? e.message : "実行できませんでした。");
      } finally {
        setIsSending(false);
      }
    },
    [conversationId, isSending],
  );

  return {
    conversations,
    conversationId,
    messages,
    context,
    isSending,
    error,
    open,
    startNew,
    send,
    resolveConfirm,
  };
}
