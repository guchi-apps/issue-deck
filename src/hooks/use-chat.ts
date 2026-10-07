"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMemoryOp } from "@/lib/chat/session";
import type {
  ChatConversationStatus,
  ChatContext,
  ChatFreshness,
  ChatMemory,
  ChatMessageView,
  ChatRunView,
} from "@/lib/chat/types";
import { EMPTY_CHAT_MEMORY } from "@/lib/chat/types";

export type ChatConversationSummary = {
  id: string;
  title: string;
  repo: string | null;
  targets: { repo: string; number: number; kind: "pr" | "issue" }[];
  actionCount: number;
  status: ChatConversationStatus;
  archived: boolean;
  updatedAt: string;
};

/** 送信の保存状態。`failed`の入力は画面に残り、同じ`clientId`で再送できる（二重登録されない） */
export type ChatOutboxItem = {
  clientId: string;
  text: string;
  repo: string | null;
  state: "sending" | "failed";
  error: string | null;
};

export type ChatArchiveFilter = "active" | "archived";

type OpenedConversation = {
  id: string;
  title: string;
  archived: boolean;
  accessible: boolean;
  context: ChatContext;
  memory: ChatMemory;
  messages: ChatMessageView[];
  hasMore: boolean;
  freshness: ChatFreshness[] | null;
  staleConfirms: { messageId: string; reason: string }[];
  /** サブPCのCodexで回答を作っている途中の発言（#4109）。再読込後も「回答中」を戻す */
  activeRun?: ChatRunView | null;
};

/** 回答待ちを取りに行く間隔 */
const RUN_POLL_INTERVAL_MS = 2_500;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!response.ok || !json) {
    const reason = json?.message ?? json?.error ?? String(response.status);
    if (reason === "preview_mode_forbidden") throw new Error("この環境では実行できません（プレビュー環境）。");
    if (reason === "repository_access_lost") throw new Error("このリポジトリへのアクセス権が無いため、この会話では実行できません。");
    if (reason === "conflict") throw new Error("他の端末の更新と重なりました。もう一度お試しください。");
    if (reason === "run_in_progress") throw new Error("前の発言の回答を作っています。回答が届いてから送ってください。");
    throw new Error(reason);
  }
  return json;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** IssueDeck Chatの会話セッション一覧と、開いている会話の発言・メモ・再開時の最新状態（#3975・#4047） */
export function useChat(active: boolean) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [archiveFilter, setArchiveFilter] = useState<ChatArchiveFilter>("active");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [archived, setArchived] = useState(false);
  const [accessible, setAccessible] = useState(true);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [memory, setMemory] = useState<ChatMemory>(EMPTY_CHAT_MEMORY);
  const [freshness, setFreshness] = useState<ChatFreshness[] | null>(null);
  const [staleConfirms, setStaleConfirms] = useState<Record<string, string>>({});
  const [outbox, setOutbox] = useState<ChatOutboxItem[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<ChatRunView | null>(null);
  const idRef = useRef<string | null>(null);

  const listUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    params.set("archived", archiveFilter === "archived" ? "1" : "0");
    return `/api/chat?${params}`;
  }, [query, archiveFilter]);

  const refreshList = useCallback(async () => {
    try {
      const json = await requestJson<{ conversations: ChatConversationSummary[] }>(listUrl());
      setConversations(json.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "会話の一覧を読み込めませんでした。");
    }
  }, [listUrl]);

  // 検索語は入力が落ち着いてから引く（1文字ごとにAPIを叩かない）
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void refreshList(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [active, query, archiveFilter, refreshList]);

  const applyOpened = useCallback((json: OpenedConversation) => {
    idRef.current = json.id;
    setConversationId(json.id);
    setTitle(json.title);
    setArchived(json.archived);
    setAccessible(json.accessible);
    setMessages(json.messages);
    setHasMore(json.hasMore);
    setContext(json.context);
    setMemory(json.memory);
    setFreshness(json.freshness);
    setStaleConfirms(Object.fromEntries(json.staleConfirms.map((item) => [item.messageId, item.reason])));
    setRun(json.activeRun ?? null);
  }, []);

  /** 開き直し・別端末で開く場合の復元。`refresh`でGitHub上の現在の状態も取り直す */
  const open = useCallback(
    async (id: string) => {
      setError(null);
      setOutbox([]);
      try {
        applyOpened(await requestJson<OpenedConversation>(`/api/chat/${id}?refresh=1`));
      } catch (e) {
        setError(e instanceof Error ? e.message : "会話を開けませんでした。");
      }
    },
    [applyOpened],
  );

  const loadOlder = useCallback(async () => {
    const id = idRef.current;
    const first = messages[0];
    if (!id || !first) return;
    try {
      const json = await requestJson<{ messages: ChatMessageView[]; hasMore: boolean }>(
        `/api/chat/${id}?before=${first.id}`,
      );
      setMessages((current) => [...json.messages, ...current]);
      setHasMore(json.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "過去の発言を読み込めませんでした。");
    }
  }, [messages]);

  // 別端末で進んだ内容を、画面に戻ったときに取り込む（送信中は触らない）
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      const id = idRef.current;
      if (document.visibilityState !== "visible" || !id) return;
      void requestJson<OpenedConversation>(`/api/chat/${id}`)
        .then((json) => {
          if (idRef.current !== id) return;
          setMessages(json.messages);
          setHasMore(json.hasMore);
          setContext(json.context);
          setMemory(json.memory);
          setTitle(json.title);
          setArchived(json.archived);
          setRun(json.activeRun ?? null);
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active]);

  const startNew = useCallback(() => {
    idRef.current = null;
    setConversationId(null);
    setTitle("");
    setArchived(false);
    setAccessible(true);
    setMessages([]);
    setHasMore(false);
    setContext(null);
    setMemory(EMPTY_CHAT_MEMORY);
    setFreshness(null);
    setStaleConfirms({});
    setOutbox([]);
    setError(null);
    setRun(null);
  }, []);

  // 回答待ち（Codex CLI経由。#4109）の間は、結果を取りに行く。届いたら返信を足して終える
  useEffect(() => {
    const id = conversationId;
    if (!active || !id || run?.status !== "running") return;
    const runId = run.id;
    let stopped = false;
    const timer = setInterval(() => {
      void requestJson<{
        run: ChatRunView;
        message: ChatMessageView | null;
        context: ChatContext | null;
        memory: ChatMemory | null;
      }>(`/api/chat/${id}/run?runId=${encodeURIComponent(runId)}`)
        .then((json) => {
          if (stopped || idRef.current !== id) return;
          if (json.run.status === "running") {
            setRun((current) => (current?.id === runId ? json.run : current));
            return;
          }
          if (json.message) {
            const message = json.message;
            setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
          }
          if (json.context) setContext(json.context);
          if (json.memory) setMemory(json.memory);
          setRun(null);
          void refreshList();
        })
        .catch(() => undefined);
    }, RUN_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, conversationId, run?.id, run?.status, refreshList]);

  const deliver = useCallback(
    async (item: ChatOutboxItem) => {
      setIsSending(true);
      setError(null);
      setOutbox((current) =>
        current.map((o) => (o.clientId === item.clientId ? { ...o, state: "sending", error: null } : o)),
      );
      try {
        let id = idRef.current;
        if (!id) {
          const created = await requestJson<{ id: string }>("/api/chat", jsonInit("POST", { repo: item.repo }));
          id = created.id;
          idRef.current = id;
          setConversationId(id);
        }
        const json = await requestJson<{
          messages: ChatMessageView[];
          context?: ChatContext;
          memory?: ChatMemory;
          run?: ChatRunView | null;
        }>(`/api/chat/${id}`, jsonInit("POST", { text: item.text, clientMessageId: item.clientId }));
        setMessages((current) => {
          const known = new Set(current.map((m) => m.id));
          return [...current, ...json.messages.filter((m) => !known.has(m.id))];
        });
        if (json.context) setContext(json.context);
        if (json.memory) setMemory(json.memory);
        // Codexで回答を作る場合は、発言だけが保存されて返る（回答は後から取りに行く）
        if (json.run?.status === "running") setRun(json.run);
        setOutbox((current) => current.filter((o) => o.clientId !== item.clientId));
        setTitle((current) => current || item.text.slice(0, 40));
        void refreshList();
      } catch (e) {
        const message = e instanceof Error ? e.message : "送信できませんでした。";
        setOutbox((current) =>
          current.map((o) => (o.clientId === item.clientId ? { ...o, state: "failed", error: message } : o)),
        );
      } finally {
        setIsSending(false);
      }
    },
    [refreshList],
  );

  const send = useCallback(
    async (text: string, repo: string | null) => {
      const body = text.trim();
      if (!body || isSending || run?.status === "running") return;
      const item: ChatOutboxItem = { clientId: newClientId(), text: body, repo, state: "sending", error: null };
      setOutbox((current) => [...current, item]);
      await deliver(item);
    },
    [deliver, isSending, run?.status],
  );

  /** 保存に失敗した発言を、同じIDで再送する（サーバー側で保存済みなら二重登録されない） */
  const retry = useCallback(
    async (clientId: string) => {
      const item = outbox.find((o) => o.clientId === clientId);
      if (item && !isSending) await deliver(item);
    },
    [deliver, isSending, outbox],
  );

  const discardFailed = useCallback((clientId: string) => {
    setOutbox((current) => current.filter((o) => o.clientId !== clientId));
  }, []);

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
        }>(`/api/chat/${conversationId}/confirm`, jsonInit("POST", { messageId, action, ...overrides }));
        setMessages((current) => [
          ...current.map((message) =>
            message.id === messageId ? { ...message, confirmState: json.confirmState } : message,
          ),
          ...json.messages,
        ]);
        if (json.context) setContext(json.context);
        void refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : "実行できませんでした。");
        // 他端末で解決済みのときは、最新の状態へ合わせる
        void open(conversationId);
      } finally {
        setIsSending(false);
      }
    },
    [conversationId, isSending, open, refreshList],
  );

  const patch = useCallback(
    async (id: string, body: { title?: string; archived?: boolean; memoryOp?: ChatMemoryOp }) => {
      setError(null);
      try {
        const json = await requestJson<{ title: string; archived: boolean; memory: ChatMemory }>(
          `/api/chat/${id}`,
          jsonInit("PATCH", body),
        );
        if (idRef.current === id) {
          setTitle(json.title);
          setArchived(json.archived);
          setMemory(json.memory);
        }
        void refreshList();
      } catch (e) {
        setError(e instanceof Error ? e.message : "更新できませんでした。");
      }
    },
    [refreshList],
  );

  return {
    conversations,
    query,
    setQuery,
    archiveFilter,
    setArchiveFilter,
    conversationId,
    title,
    archived,
    accessible,
    messages,
    hasMore,
    context,
    memory,
    freshness,
    staleConfirms,
    outbox,
    isSending,
    run,
    error,
    open,
    loadOlder,
    startNew,
    send,
    retry,
    discardFailed,
    resolveConfirm,
    rename: (id: string, next: string) => patch(id, { title: next }),
    setArchivedFor: (id: string, next: boolean) => patch(id, { archived: next }),
    memoryOp: (op: ChatMemoryOp) => (idRef.current ? patch(idRef.current, { memoryOp: op }) : Promise.resolve()),
  };
}
