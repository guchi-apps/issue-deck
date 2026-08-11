"use client";

import { ChevronLeft } from "lucide-react";

import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { OpenPullRequest } from "@/types/pull-request";

type MobilePullRequestsScreenProps = {
  pullRequests: OpenPullRequest[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
};

/**
 * スマホのマージ待ちPR一覧画面（#1058）。PC版と同じ`PullRequestList`をそのまま使い、
 * ヘッダー左に戻る導線を差し込むだけにしている（一覧の中身に画面幅固有の出し分けが無いため）。
 */
export function MobilePullRequestsScreen({
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  error,
  onRefresh,
  onBack,
}: MobilePullRequestsScreenProps) {
  return (
    <PullRequestList
      pullRequests={pullRequests}
      failedRepositories={failedRepositories}
      fetchedAt={fetchedAt}
      isLoading={isLoading}
      error={error}
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
