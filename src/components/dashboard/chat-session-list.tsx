"use client";

import { Archive, ArchiveRestore, Check, Pencil, Search, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMonthDayTime } from "@/lib/format-date-time";
import type { ChatArchiveFilter, ChatConversationSummary } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

function formatUpdatedAt(iso: string): string {
  return formatMonthDayTime(iso);
}

/** 会話セッションの一覧。検索（タイトル・本文・番号）・名前変更・アーカイブ／解除ができる（#4047） */
export function ChatSessionList({
  conversations,
  selectedId,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onOpen,
  onRename,
  onArchive,
}: {
  conversations: ChatConversationSummary[];
  selectedId: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  filter: ChatArchiveFilter;
  onFilterChange: (value: ChatArchiveFilter) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = (id: string) => {
    const next = draft.trim();
    if (next) onRename(id, next);
    setEditingId(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
        <input
          type="search"
          aria-label="会話を検索"
          placeholder="タイトル・本文・#番号"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="h-8 w-full rounded-lg border bg-transparent pl-7 pr-2 text-xs"
        />
      </div>
      <div className="flex gap-1 text-xs" role="tablist" aria-label="会話の表示">
        {(["active", "archived"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => onFilterChange(value)}
            className={cn("rounded-full border px-2.5 py-0.5", filter === value ? "bg-muted font-semibold" : "text-muted-foreground")}
          >
            {value === "active" ? "会話" : "アーカイブ済み"}
          </button>
        ))}
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="会話の履歴">
        {conversations.length === 0 && (
          <li className="text-xs text-muted-foreground">
            {query ? "一致する会話はありません。" : filter === "archived" ? "アーカイブ済みの会話はありません。" : "まだ会話はありません。"}
          </li>
        )}
        {conversations.map((item) => (
          <li
            key={item.id}
            className={cn("rounded-lg border border-transparent px-2 py-1.5 hover:bg-muted", selectedId === item.id && "border-border bg-muted")}
          >
            {editingId === item.id ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  commit(item.id);
                }}
              >
                <input
                  autoFocus
                  aria-label="会話の名前"
                  maxLength={120}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-xs"
                />
                <Button type="submit" variant="ghost" size="icon-sm" aria-label="名前を保存"><Check /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="名前変更をやめる" onClick={() => setEditingId(null)}><X /></Button>
              </form>
            ) : (
              <>
                <button type="button" onClick={() => onOpen(item.id)} className="block w-full text-left">
                  <span className="block truncate text-xs font-semibold">{item.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span>{formatUpdatedAt(item.updatedAt)}</span>
                    {item.targets.slice(0, 3).map((target) => (
                      <span key={`${target.repo}#${target.number}`} className="rounded-full border px-1.5 font-mono">
                        {target.kind === "pr" ? "PR" : "#"}{target.number}
                      </span>
                    ))}
                    {item.status === "waiting" && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-700 dark:text-amber-300">判断待ち</span>
                    )}
                    {item.actionCount > 0 && <span>実行{item.actionCount}件</span>}
                  </span>
                </button>
                <div className="mt-1 flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="名前を変更"
                    onClick={() => {
                      setDraft(item.title);
                      setEditingId(item.id);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={item.archived ? "アーカイブを解除" : "アーカイブ"}
                    onClick={() => onArchive(item.id, !item.archived)}
                  >
                    {item.archived ? <ArchiveRestore /> : <Archive />}
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
