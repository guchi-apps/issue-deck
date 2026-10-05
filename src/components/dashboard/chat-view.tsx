"use client";

import { Loader2, MessageSquarePlus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChatCardView } from "@/components/dashboard/chat-cards";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

const PLACEHOLDER = "メッセージを入力（例：3966どうなってる？ / 直して / 別Issueにして）";

/**
 * IssueDeck Chat（#3975）。自然言語から既存のIssue・PR・PR自動修正・Issue起案を呼ぶ入口。
 * 一覧・Issue/PR詳細は今のまま残り、回答のカードからそれらへ移れる。
 */
export function ChatView({
  active = true,
  repositories,
  defaultRepo,
  onBack,
  onOpenPullRequest,
}: {
  active?: boolean;
  /** 会話に紐づける候補（`owner/repo`）。番号だけの発言を補う既定のrepositoryになる */
  repositories: string[];
  defaultRepo: string | null;
  onBack?: () => void;
  onOpenPullRequest: (repo: string, number: number) => void;
}) {
  const chat = useChat(active);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState<string | null>(defaultRepo ?? repositories[0] ?? null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages.length, chat.isSending]);

  const submit = (value: string) => {
    const body = value.trim();
    if (!body) return;
    setText("");
    void chat.send(body, repo);
  };

  const targets = chat.context?.targets ?? [];

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {onBack && <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={onBack}>← 戻る</Button>}
          <h2 className="text-sm font-bold">チャット</h2>
          <p className="text-[11px] text-muted-foreground">Issue・PRの状態確認や修復を、会話で進めます</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="chat-repo">対象のリポジトリ</label>
          <select
            id="chat-repo"
            value={repo ?? ""}
            disabled={chat.conversationId !== null}
            onChange={(event) => setRepo(event.target.value || null)}
            className="h-8 max-w-52 rounded-lg border bg-transparent px-2 text-xs"
          >
            {repositories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={chat.startNew}>
            <MessageSquarePlus />新しい会話
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="hidden w-52 shrink-0 flex-col gap-1 overflow-y-auto lg:flex" aria-label="会話の履歴">
          {chat.conversations.length === 0 && <p className="text-xs text-muted-foreground">まだ会話はありません。</p>}
          {chat.conversations.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void chat.open(item.id)}
              className={cn(
                "truncate rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-muted",
                chat.conversationId === item.id && "bg-muted font-semibold",
              )}
            >
              {item.title}
            </button>
          ))}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border">
          {targets.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
              いまの対象：
              {targets.map((target) => (
                <span key={`${target.repo}#${target.number}`} className="rounded-full border bg-background px-2 py-px font-mono text-foreground">
                  {target.kind === "pr" ? "PR" : "Issue"} #{target.number}
                </span>
              ))}
              <span>（「それ」「直して」はこの対象を指します）</span>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" aria-live="polite">
            {chat.messages.length === 0 && (
              <p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
                「3966どうなってる？」のように番号を送ると、CI・レビュー・コンフリクト・修復の状態を返します。
              </p>
            )}
            {chat.messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="max-w-[85%] self-end whitespace-pre-wrap rounded-xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm">
                  {message.text}
                </div>
              ) : (
                <div key={message.id} className="flex max-w-full min-w-0 flex-col gap-2 self-start text-sm md:max-w-[85%]">
                  {message.text && <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>}
                  {message.cards.map((card, index) => (
                    <ChatCardView
                      key={index}
                      card={card}
                      confirmState={message.confirmState}
                      busy={chat.isSending}
                      onSend={submit}
                      onConfirm={(action, overrides) => void chat.resolveConfirm(message.id, action, overrides)}
                      onOpenPullRequest={onOpenPullRequest}
                    />
                  ))}
                </div>
              ),
            )}
            {chat.isSending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />処理しています…</div>
            )}
            <div ref={endRef} />
          </div>
          {chat.error && <p role="alert" className="border-t px-3 py-1.5 text-xs text-destructive">{chat.error}</p>}
          <form
            className="flex items-end gap-2 border-t p-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit(text);
            }}
          >
            <Textarea
              id="chat-input"
              aria-label="メッセージ"
              value={text}
              placeholder={PLACEHOLDER}
              rows={1}
              className="min-h-9 flex-1"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit(text);
                }
              }}
            />
            <Button type="submit" size="sm" disabled={chat.isSending || !text.trim()}><Send />送信</Button>
          </form>
        </div>
      </div>
    </section>
  );
}
