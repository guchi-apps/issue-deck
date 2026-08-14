"use client";

import { ChevronLeft } from "lucide-react";

import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

type MobilePullRequestsScreenProps = {
  view: PullRequestViewId;
  pullRequests: PullRequestSummary[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
  /** PRを選んだとき。スマホでは同じ画面枠のままPR詳細へ切り替える（#1087） */
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onMerged: (pullRequest: PullRequestSummary) => void;
};

/**
 * スマホのPR一覧画面（#1058）。PC版と同じ`PullRequestList`をそのまま使い、
 * ヘッダー左に戻る導線を差し込むだけにしている（一覧の中身に画面幅固有の出し分けが無いため）。
 */
export function MobilePullRequestsScreen({
  view,
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  error,
  onRefresh,
  onBack,
  onSelectPullRequest,
  onMerged,
}: MobilePullRequestsScreenProps) {
  return (
    <PullRequestList
      view={view}
      pullRequests={pullRequests}
      failedRepositories={failedRepositories}
      fetchedAt={fetchedAt}
      isLoading={isLoading}
      error={error}
      onRefresh={onRefresh}
      onSelectPullRequest={onSelectPullRequest}
      onMerged={onMerged}
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
