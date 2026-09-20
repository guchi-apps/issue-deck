"use client";

import { ExternalLink, Lightbulb, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIdeas, type IdeaSummary } from "@/hooks/use-ideas";

const IDEAS_URL = "https://github.com/guchi-apps/ideas/tree/main/ideas";

export function IdeasPanel({ active = true, onBack }: { active?: boolean; onBack?: () => void }) {
  const { ideas, isLoading, deletingPath, error, refresh, remove } = useIdeas(active);
  const [deleteTarget, setDeleteTarget] = useState<IdeaSummary | null>(null);

  return (
    <section className="flex min-h-full flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {onBack && <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={onBack}>← 戻る</Button>}
          <p className="text-xs text-muted-foreground">新規アプリ</p>
          <h1 className="font-heading text-2xl font-semibold">構想</h1>
          <p className="mt-1 text-sm text-muted-foreground">立ち上げ前のアイデアを確認・整理します</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
            <RefreshCw className={isLoading ? "animate-spin" : ""} />更新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={IDEAS_URL} target="_blank" rel="noreferrer">GitHubで編集<ExternalLink /></a>
          </Button>
        </div>
      </header>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {isLoading && ideas.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="animate-spin" />構想を読み込んでいます…</div>
      ) : ideas.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center">
          <Lightbulb className="mb-3 size-8 text-muted-foreground" />
          <p className="font-medium">構想はまだありません</p>
          <p className="mt-1 text-sm text-muted-foreground">guchi-apps/ideas に構想メモを追加すると、ここに表示されます。</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ideas.map((idea) => (
            <article key={idea.path} className="flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><h2 className="truncate font-heading text-lg font-semibold">{idea.title}</h2><p className="font-mono text-xs text-muted-foreground">{idea.name}</p></div>
                <Badge variant="secondary">{idea.state ?? "未決"}</Badge>
              </div>
              {idea.summary && <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{idea.summary}</p>}
              <details className="group mt-4 border-t pt-3">
                <summary className="cursor-pointer text-sm font-medium text-primary">内容を見る</summary>
                <div className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-muted/30 p-3"><MarkdownBody content={idea.markdown} /></div>
              </details>
              <Button variant="ghost" size="sm" className="mt-3 self-end text-destructive hover:text-destructive" onClick={() => setDeleteTarget(idea)}>
                <Trash2 />削除
              </Button>
            </article>
          ))}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>「{deleteTarget?.title}」を削除しますか？</AlertDialogTitle><AlertDialogDescription>構想ディレクトリ内のファイルをまとめて削除します。画面上では取り消せません。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>キャンセル</AlertDialogCancel><AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={deletingPath !== null} onClick={(event) => { event.preventDefault(); if (deleteTarget) void remove(deleteTarget.path).then((ok) => ok && setDeleteTarget(null)); }}>{deletingPath ? "削除中…" : "削除する"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
