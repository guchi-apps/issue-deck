"use client";

import { AlertTriangle, History, Loader2, MessageSquarePlus, NotebookPen, RotateCw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChatCardView } from "@/components/dashboard/chat-cards";
import { ChatMemoryPanel } from "@/components/dashboard/chat-memory-panel";
import { ChatSessionList } from "@/components/dashboard/chat-session-list";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@/hooks/use-chat";

const PLACEHOLDER = "メッセージを入力（例：勤務画面を週表示にしたい / 3966どうなってる？ / 別Issueにして）";

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
  const [showList, setShowList] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages.length, chat.outbox.length, chat.isSending, chat.run?.id]);

  // サブPCのCodexで回答を作っている間（#4109）。次の発言は回答が届いてから送る
  const waitingRun = chat.run?.status === "running" ? chat.run : null;
  const busy = chat.isSending || waitingRun !== null;

  const submit = (value: string) => {
    const body = value.trim();
    if (!body || busy) return;
    setText("");
    void chat.send(body, repo);
  };

  const openConversation = (id: string) => {
    setShowList(false);
    void chat.open(id);
  };

  const sessionList = (
    <ChatSessionList
      conversations={chat.conversations}
      selectedId={chat.conversationId}
      query={chat.query}
      onQueryChange={chat.setQuery}
      filter={chat.archiveFilter}
      onFilterChange={chat.setArchiveFilter}
      onOpen={openConversation}
      onRename={(id, title) => void chat.rename(id, title)}
      onArchive={(id, archived) => void chat.setArchivedFor(id, archived)}
    />
  );

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
          <Button variant="outline" size="sm" className="lg:hidden" aria-expanded={showList} onClick={() => setShowList((v) => !v)}>
            <History />履歴
          </Button>
          <Button variant="outline" size="sm" aria-expanded={showMemory} disabled={!chat.conversationId} onClick={() => setShowMemory((v) => !v)}>
            <NotebookPen />メモ・調査
          </Button>
          <Button variant="outline" size="sm" onClick={() => { chat.startNew(); setShowList(false); }}>
            <MessageSquarePlus />新しい会話
          </Button>
        </div>
      </header>

      {showList && <div className="flex max-h-64 flex-col rounded-lg border p-2 lg:hidden">{sessionList}</div>}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="hidden w-56 shrink-0 flex-col lg:flex">{sessionList}</aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border">
          {chat.conversationId && (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-semibold">{chat.title}</span>
              {chat.archived && (
                <>
                  <span className="rounded-full border px-2 text-muted-foreground">アーカイブ済み</span>
                  <Button variant="outline" size="sm" onClick={() => void chat.setArchivedFor(chat.conversationId!, false)}>解除</Button>
                </>
              )}
            </div>
          )}
          {!chat.accessible && (
            <p role="alert" className="flex items-center gap-1.5 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />このリポジトリへのアクセス権が無いため、履歴の閲覧だけできます（新しい取得・操作はできません）。
            </p>
          )}
          {chat.freshness?.some((item) => item.changes.length > 0) && (
            <p className="border-b bg-amber-500/10 px-3 py-1.5 text-xs">
              前回の調査から状態が変わった対象があります。「メモ・調査」で調査時点との差を確認できます。
            </p>
          )}
          {showMemory && chat.conversationId && (
            <div className="max-h-72 overflow-y-auto border-b p-3">
              <ChatMemoryPanel memory={chat.memory} freshness={chat.freshness} actions={chat.context?.actions ?? []} onOp={(op) => void chat.memoryOp(op)} />
            </div>
          )}
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
            {chat.hasMore && (
              <Button variant="ghost" size="sm" className="self-center" onClick={() => void chat.loadOlder()}>過去の発言を読み込む</Button>
            )}
            {chat.messages.length === 0 && chat.outbox.length === 0 && (
              <p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
                「3966どうなってる？」のように番号を送ると、CI・レビュー・コンフリクト・修復の状態を返します。番号がなくても、困りごとや改善案（例：「勤務画面を週ごとに表示したい」）を送れば、案の比較から「これでIssue起案して」まで相談できます。
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
                  {chat.staleConfirms[message.id] && message.confirmState === "pending" && (
                    <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
                      現在の状態と照合しました：{chat.staleConfirms[message.id]}
                    </p>
                  )}
                  {message.cards.map((card, index) => (
                    <ChatCardView
                      key={index}
                      card={card}
                      confirmState={message.confirmState}
                      busy={busy}
                      onSend={submit}
                      onConfirm={(action, overrides) => void chat.resolveConfirm(message.id, action, overrides)}
                      onOpenPullRequest={onOpenPullRequest}
                    />
                  ))}
                </div>
              ),
            )}
            {chat.outbox.map((item) => (
              <div key={item.clientId} className="flex max-w-[85%] flex-col items-end gap-1 self-end">
                <div className="whitespace-pre-wrap rounded-xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm opacity-70">{item.text}</div>
                {item.state === "sending" ? (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin" />保存中…</span>
                ) : (
                  <span role="alert" className="flex flex-wrap items-center justify-end gap-1 text-[11px] text-destructive">
                    保存できませんでした{item.error ? `（${item.error}）` : ""}
                    <Button variant="outline" size="sm" disabled={chat.isSending} onClick={() => void chat.retry(item.clientId)}><RotateCw />再送</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setText((current) => current || item.text); chat.discardFailed(item.clientId); }}>入力欄へ戻す</Button>
                  </span>
                )}
              </div>
            ))}
            {chat.isSending && chat.outbox.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />処理しています…</div>
            )}
            {waitingRun && !chat.isSending && (
              <div role="status" className="flex flex-col gap-0.5 self-start text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  Codexで回答中（サブPC{waitingRun.model ? `・${waitingRun.model}` : ""}）
                </span>
                <span className="pl-5">
                  {waitingRun.phase || "サブPCの受け取り待ち"}。通常は十数秒〜1分ほどです。画面を閉じても回答は会話に残ります。
                </span>
                <button type="button" className="self-start pl-5 text-xs underline" onClick={() => void chat.cancelRun()}>
                  回答を中止する
                </button>
              </div>
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
            <Button type="submit" size="sm" disabled={busy || !text.trim()}><Send />送信</Button>
          </form>
        </div>
      </div>
    </section>
  );
}
