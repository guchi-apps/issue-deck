"use client";

import { ChevronLeft } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { PreviewPanel } from "@/components/dashboard/preview-panel";
import type { DispatchHostView, DispatchJobView, PreviewAction } from "@/lib/dispatch/dispatch-job";

/**
 * スマホの「確認環境」画面（#2444）。
 *
 * PC版と**同じ`PreviewPanel`**を`compact`で縮めて使う。器（全画面かペインか）だけがPCと違う。
 *
 * **この画面がスマホにあることがこの機能の要点。** tailnetのURLをここから開けば、
 * mainへ出す前のdevelopをそのままスマホの実機で確かめられる（URLを手で打ち込まずに済む）。
 *
 * ボトムナビのタブは持たない（枠は「ホーム」「Issue」「PR」「ブランチ」で埋まっている）ので、
 * ホームのメニューからのドリルダウンにして、設定画面と同じくヘッダーに戻るボタンを出す。
 */
export function MobilePreviewScreen({
  hosts,
  jobs,
  isLoaded,
  onRequestPreview,
  onBack,
}: {
  hosts: readonly DispatchHostView[];
  jobs: readonly DispatchJobView[];
  isLoaded: boolean;
  onRequestPreview: (params: {
    hostName: string;
    repositoryFullName: string;
    action: PreviewAction;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
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
        <h1 className="flex-1 text-base font-semibold">確認環境</h1>
        <MobileDispatchStatusButton />
        {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
        <MobileNotificationButton />
      </header>

      {/* ボトムナビぶんの余白を最後に足す（他のスマホ画面と同じ`pb-20`） */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20">
        <PreviewPanel
          hosts={hosts}
          jobs={jobs}
          isLoaded={isLoaded}
          onRequestPreview={onRequestPreview}
          compact
        />
      </div>
    </div>
  );
}
