"use client";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { ReleaseHistoryPanel } from "@/components/dashboard/release-history-panel";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";

/**
 * スマホの「リリース履歴」画面（#2726）。
 *
 * PC版と**同じ`ReleaseHistoryPanel`**を`compact`で縮めて使う（`mobile-preview-screen.tsx`と
 * 同じ切り分け）。
 *
 * **#2811でボトムナビの3枠目（「リリース」）を持つようになった。** それまではホームのメニュー
 * からのドリルダウンだったのでヘッダーに戻るボタンを出していたが、タブから直接開く画面には
 * 戻り先が無い（「AI使用量」「ブランチ」画面と同じ）ため外した。
 */
export function MobileReleaseHistoryScreen({
  entries,
  isLoading,
  error,
  onRefresh,
}: {
  entries: ReleaseHistoryItem[] | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        <h1 className="flex-1 text-base font-semibold">リリース履歴</h1>
        <MobileDispatchStatusButton />
        <MobileNotificationButton />
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20">
        <ReleaseHistoryPanel
          entries={entries}
          isLoading={isLoading}
          error={error}
          onRefresh={onRefresh}
          compact
        />
      </div>
    </div>
  );
}
