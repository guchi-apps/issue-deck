"use client";

import { ExternalLink, Loader2, Plus, RefreshCw, Smartphone } from "lucide-react";
import { useState } from "react";

import {
  IosExtensionIssueDialog,
  type IosExtensionIssueTarget,
} from "@/components/dashboard/ios-extension-issue-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIosExtensions } from "@/hooks/use-ios-extensions";
import { IOS_EXTENSION_KIND_LABELS } from "@/lib/ios-extensions";
import type { Issue } from "@/types/issue";

/** iOS拡張一覧（#3708）。リポジトリのSwiftソースから検出したウィジェット・ロック画面・ライブアクティビティ・コントロール */
export function IosExtensionsPanel({ active = true, onBack, onIssueCreated }: { active?: boolean; onBack?: () => void; onIssueCreated: (issue: Issue) => void }) {
  const { repositories, isLoading, error, refresh } = useIosExtensions(active);
  const [target, setTarget] = useState<IosExtensionIssueTarget | null>(null);
  const names = repositories.map((repository) => repository.fullName);

  return (
    <section className="flex min-h-full flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {onBack && <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={onBack}>← 戻る</Button>}
          <h2 className="flex items-center gap-1.5 text-sm font-bold">
            <Smartphone className="size-4" aria-hidden />
            iOS拡張
          </h2>
          <p className="text-[11px] text-muted-foreground">ソースから検出したウィジェット・ロック画面・ライブアクティビティ・コントロール（検出結果のため漏れることがあります）</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={isLoading}>
            <RefreshCw className={isLoading ? "animate-spin" : ""} />更新
          </Button>
          <Button size="sm" disabled={names.length === 0} onClick={() => setTarget({ repositoryFullName: names[0], extension: null })}>
            <Plus />拡張を追加
          </Button>
        </div>
      </header>

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {isLoading && repositories.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="animate-spin" />iOS拡張を読み込んでいます…</div>
      ) : repositories.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">iOSアプリのリポジトリが接続されていません。</div>
      ) : (
        <div className="space-y-3">
          {repositories.map((repository) => (
            <article key={repository.fullName} className="min-w-0 rounded-xl border bg-card shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <a href={repository.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-semibold hover:underline">
                  {repository.fullName}<ExternalLink className="size-3" />
                </a>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{repository.error ? "取得失敗" : repository.extensions.length > 0 ? `拡張 ${repository.extensions.length}件を検出` : "拡張なし"}</Badge>
                  <Button variant="outline" size="sm" onClick={() => setTarget({ repositoryFullName: repository.fullName, extension: null })}><Plus />追加</Button>
                </div>
              </div>
              {repository.error ? (
                <p className="px-4 py-3 text-sm text-destructive">{repository.error}</p>
              ) : repository.extensions.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">Swiftソースから拡張を検出できませんでした（{repository.scannedFiles}ファイルを走査）。</p>
              ) : (
                <ul className="divide-y">
                  {repository.extensions.map((extension) => (
                    <li key={`${extension.kind}:${extension.path}:${extension.name}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2"><Badge variant="outline">{IOS_EXTENSION_KIND_LABELS[extension.kind]}</Badge><span className="font-medium">{extension.displayName ?? extension.name}</span></p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{extension.path}</p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setTarget({ repositoryFullName: repository.fullName, extension })}>編集を依頼</Button>
                    </li>
                  ))}
                </ul>
              )}
              {repository.truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">候補が多いため一部のファイルだけを走査しました。</p>}
            </article>
          ))}
        </div>
      )}

      <IosExtensionIssueDialog target={target} repositories={names} onClose={() => setTarget(null)} onCreated={onIssueCreated} />
    </section>
  );
}
