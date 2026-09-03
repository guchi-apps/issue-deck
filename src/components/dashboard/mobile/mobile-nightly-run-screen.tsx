"use client";

import { ChevronLeft } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { NightlyRunPanel } from "@/components/dashboard/nightly-run-panel";
import type { NightlyRunHandle } from "@/hooks/use-nightly-run";

/**
 * スマホの「夜間実行」画面（#2772）。
 *
 * PC版と**同じ`NightlyRunPanel`**を`compact`で縮めて使う（`mobile-release-history-screen.tsx`と
 * 同じ切り分け）。ボトムナビのタブは持たず、ホームのメニューからのドリルダウンにする。
 */
export function MobileNightlyRunScreen({
  nightlyRun,
  onOpenIssue,
  onBack,
}: {
  nightlyRun: NightlyRunHandle;
  onOpenIssue: (repositoryFullName: string, issueNumber: number) => void;
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
        <h1 className="flex-1 text-base font-semibold">夜間実行</h1>
        <MobileDispatchStatusButton />
        <MobileNotificationButton />
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20">
        <NightlyRunPanel
          state={nightlyRun.state}
          isLoading={nightlyRun.isLoading}
          error={nightlyRun.error}
          isSubmitting={nightlyRun.isSubmitting}
          onRefresh={nightlyRun.refresh}
          onCancel={(id) => void nightlyRun.cancel(id)}
          onUpdateSettings={(patch) => void nightlyRun.updateSettings(patch)}
          onOpenIssue={onOpenIssue}
          compact
        />
      </div>
    </div>
  );
}
