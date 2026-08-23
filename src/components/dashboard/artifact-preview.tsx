"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { ExternalLink, SquareArrowOutUpRight, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useHistoryDismiss } from "@/hooks/use-history-dismiss";
import { ARTIFACT_IFRAME_SANDBOX } from "@/lib/artifact-document";
import { artifactWindowPath, openArtifactWindow } from "@/lib/artifact-window";
import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";

type ArtifactPreview = {
  /** 保存済みの1件をアプリ内で開く */
  open: (artifact: SessionArtifactView) => void;
  /** claude.aiのアーティファクトIDから引く。**本文中のリンクを差し替えるための入口** */
  findByClaudeId: (claudeArtifactId: string) => SessionArtifactView | null;
};

const ArtifactPreviewContext = createContext<ArtifactPreview | null>(null);

/**
 * アーティファクトをアプリ内で開くための受け口（#2154）。
 *
 * **providerが無い場所ではnullを返す**（`github-reference-navigation.tsx`と同じ流儀）。
 * 本文中のリンクはその場合に従来どおりclaude.aiを開く外部リンクとして振る舞うので、
 * ダイアログ単体のテストや別の画面でも壊れない。
 */
export function useArtifactPreview(): ArtifactPreview | null {
  return useContext(ArtifactPreviewContext);
}

/**
 * 選択中のIssueのアーティファクトを配り、重ね表示そのものも持つ。
 *
 * 開く操作は「アーティファクト」セクションのカードと、本文・コメントの中の
 * claude.aiリンクの2か所から来る。**リンクはMarkdownの深い位置に現れる**ので、
 * propsのバケツリレーではなくcontextで渡す。
 */
export function ArtifactPreviewProvider({
  artifacts,
  children,
}: {
  artifacts: SessionArtifactView[];
  children: ReactNode;
}) {
  const [target, setTarget] = useState<SessionArtifactView | null>(null);

  const value = useMemo<ArtifactPreview>(
    () => ({
      open: (artifact) => setTarget(artifact),
      findByClaudeId: (claudeArtifactId) =>
        artifacts.find((artifact) => artifact.claudeArtifactId === claudeArtifactId) ?? null,
    }),
    [artifacts],
  );

  const close = useCallback(() => setTarget(null), []);

  return (
    <ArtifactPreviewContext.Provider value={value}>
      {children}
      <ArtifactPreviewDialog artifact={target} onClose={close} />
    </ArtifactPreviewContext.Provider>
  );
}

/**
 * アーティファクトの重ね表示。**画像のプレビュー（`image-preview-dialog.tsx`）と同じ作り**で、
 * 閉じ方も4つ（バツボタン・Escキー・スマホの戻る操作・オーバーレイ）に揃える。
 *
 * 中身は`<iframe>`で、**`sandbox`に`allow-same-origin`を付けない**（付けるとアーティファクトの
 * JSからissue-deckのCookie・localStorageが読める）。配信側のCSPでも同じ隔離を掛けてある。
 */
function ArtifactPreviewDialog({
  artifact,
  onClose,
}: {
  artifact: SessionArtifactView | null;
  onClose: () => void;
}) {
  const open = artifact !== null;
  useHistoryDismiss(open, onClose);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-slot="artifact-preview"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">
            {artifact ? `${artifact.title} のプレビュー` : "アーティファクトのプレビュー"}
          </DialogPrimitive.Title>

          <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 text-white">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {artifact?.favicon ? `${artifact.favicon} ` : ""}
              {artifact?.title}
            </span>
            {/* **重ねて見はじめてから「本文と並べたい」と思うのが実際の流れ**（#2210）なので、
                閉じるボタンの隣に移し替えの導線を置く。開けたら重ね表示は閉じ、元の画面では
                Issueの本文・コメントが見える状態へ戻す（別ウィンドウの裏に重ね表示が残らない）。
                **スマホでは出さない**——カードの「別ウィンドウ」と同じ理由（#2065） */}
            {artifact && (
              <a
                href={artifactWindowPath(artifact.id)}
                target="_blank"
                rel="noreferrer"
                title="別ウィンドウで開く"
                aria-label="別ウィンドウで開く"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  if (event.button !== 0) return;
                  // 開けなかった場合（ポップアップブロック）はリンクのまま別タブが開くので、
                  // ここでは閉じない——重ね表示だけが消えて何も出ない、を避ける
                  if (!openArtifactWindow(artifact.id)) return;
                  event.preventDefault();
                  onClose();
                }}
                className="hidden size-9 shrink-0 place-items-center rounded-full border border-white/30 bg-white/15 transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none md:grid"
              >
                <SquareArrowOutUpRight className="size-4.5" />
              </a>
            )}
            <DialogPrimitive.Close
              aria-label="プレビューを閉じる"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-white/30 bg-white/15 transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
            >
              <X className="size-4.5" />
            </DialogPrimitive.Close>
          </div>

          {artifact && (
            <iframe
              // **アーティファクトを差し替えたら読み込み直す。** 同じ枠を使い回すと、
              // 前に開いたものが残ったまま新しいカードを押したように見える
              key={artifact.id}
              src={`/api/issues/artifacts/${artifact.id}`}
              title={artifact.title}
              sandbox={ARTIFACT_IFRAME_SANDBOX}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          )}

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-2 pb-4 text-xs text-white/70">
            {/* **忠実度の断りを画面に出す。** ここに出るのは公開時のHTMLをissue-deckが
                包み直したもので、claude.aiが足しているmermaidの描画とランタイム機能は無い */}
            <span>claude.aiでの見え方とは細部が異なります（mermaid図・保存機能は再現されません）。</span>
            {artifact?.claudeUrl && (
              <a
                href={artifact.claudeUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-white underline underline-offset-4"
              >
                claude.aiで開く
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
