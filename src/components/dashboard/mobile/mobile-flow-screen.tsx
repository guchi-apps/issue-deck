"use client";

import { ChevronLeft } from "lucide-react";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import type { BranchFlow } from "@/lib/branch-flow";

type MobileFlowScreenProps = {
  flow: BranchFlow;
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  failedRepositories: string[];
  onRefresh: () => void;
  onBack: () => void;
};

/**
 * スマホの「ブランチとPRの流れ」画面（#1455）。
 *
 * PC版と同じ`BranchFlowView`をそのまま使い、ヘッダー左の戻る導線とボトムナビぶんの余白だけを
 * 差し込む（`mobile-pull-requests-screen.tsx`と同じ形）。この画面はボトムナビのタブを持たず
 * ホームからのドリルダウンでのみ開くため、戻るボタンは常に出す。
 */
export function MobileFlowScreen({
  flow,
  fetchedAt,
  isLoading,
  error,
  failedRepositories,
  onRefresh,
  onBack,
}: MobileFlowScreenProps) {
  return (
    <BranchFlowView
      flow={flow}
      fetchedAt={fetchedAt}
      isLoading={isLoading}
      error={error}
      failedRepositories={failedRepositories}
      onRefresh={onRefresh}
      className="h-full"
      footerSpacing
      headerLeading={
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          aria-label="戻る"
        >
          <ChevronLeft className="size-5" />
        </button>
      }
    />
  );
}
