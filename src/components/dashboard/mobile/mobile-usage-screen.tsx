"use client";

import { ChevronLeft } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { SessionUsagePanel } from "@/components/dashboard/session-usage-panel";
import type { SessionUsageResponse } from "@/hooks/use-session-usage";

/**
 * スマホの「AI使用量」画面（#2504）。
 *
 * PC版と**同じ`SessionUsagePanel`**を`compact`で縮めて使う（`mobile-preview-screen.tsx`と
 * 同じ切り分け）。器（全画面かペインか）だけがPCと違う。
 *
 * ボトムナビのタブは持たない（枠は「ホーム」「Issue」「PR」「ブランチ」で埋まっている）ので、
 * ホームのメニューからのドリルダウンにして、ヘッダーに戻るボタンを出す。
 */
export function MobileUsageScreen({
  data,
  isLoading,
  error,
  days,
  onChangeDays,
  onRefresh,
  onOpenIssue,
  onBack,
}: {
  data: SessionUsageResponse | null;
  isLoading: boolean;
  error: string | null;
  days: number;
  onChangeDays: (days: number) => void;
  onRefresh: () => void;
  onOpenIssue?: (repository: string, issueNumber: number) => void;
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
        <h1 className="flex-1 text-base font-semibold">AI使用量</h1>
        <MobileDispatchStatusButton />
        <MobileNotificationButton />
      </header>

      {/* ボトムナビぶんの余白を最後に足す（他のスマホ画面と同じ`pb-20`） */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20">
        <SessionUsagePanel
          data={data}
          isLoading={isLoading}
          error={error}
          days={days}
          onChangeDays={onChangeDays}
          onRefresh={onRefresh}
          onOpenIssue={onOpenIssue}
          compact
        />
      </div>
    </div>
  );
}
