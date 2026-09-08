"use client";

import { ChevronLeft } from "lucide-react";

import { KnowledgeBoardPanel } from "@/components/dashboard/knowledge-board-panel";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import type { KnowledgeBoardData } from "@/lib/knowledge-board";

/**
 * スマホの「共通知識」画面（#2912）。
 *
 * PC版と**同じ`KnowledgeBoardPanel`**を`compact`で縮めて使う（`mobile-preview-screen.tsx`と
 * 同じ切り分け）。
 *
 * ボトムナビのタブは持たない——枠は4つで埋まっており、1枠98pxではラベルが4文字までしか入らない
 * （`docs/code-map.md`）。ホームのメニューからのドリルダウンにして、確認環境・設定と同じく
 * ヘッダーに戻るボタンを出す。
 */
export function MobileKnowledgeScreen({
  data,
  isLoading,
  error,
  onRefresh,
  onBack,
}: {
  data: KnowledgeBoardData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          aria-label="戻る"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="flex-1 text-base font-semibold">共通知識</h1>
        <MobileDispatchStatusButton />
        <MobileNotificationButton />
      </header>

      {/* ボトムナビぶんの余白を最後に足す（他のスマホ画面と同じ`pb-20`） */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20">
        <KnowledgeBoardPanel
          data={data}
          isLoading={isLoading}
          error={error}
          onRefresh={onRefresh}
          compact
        />
      </div>
    </div>
  );
}
