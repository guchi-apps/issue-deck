"use client";

import { ChevronLeft } from "lucide-react";

import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import type { ReleaseVerificationRow } from "@/lib/github/release-verification";
import type { PullRequestSummary, PullRequestDetail as PullRequestDetailData } from "@/types/pull-request";

type MobilePullRequestDetailScreenProps = {
  /** 一覧に無いPRをリンクから開いた場合、summaryが届くまではnull（#1260） */
  pullRequest: PullRequestSummary | null;
  detail: PullRequestDetailData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMerged: () => void;
  onBack: () => void;
  /** 検証結果の「修正をIssueにする」ボタン（#2838）。`PullRequestDetail`へそのまま中継する */
  onCreateFixIssue?: (row: ReleaseVerificationRow, pullRequest: PullRequestSummary) => void;
};

/**
 * スマホのPR詳細画面（#1087）。PC版と同じ`PullRequestDetail`をそのまま使い、
 * ヘッダー左に一覧へ戻る導線を差し込むだけにしている（`MobilePullRequestsScreen`と同じ方針）。
 */
export function MobilePullRequestDetailScreen({
  pullRequest,
  detail,
  isLoading,
  error,
  onRefresh,
  onMerged,
  onBack,
  onCreateFixIssue,
}: MobilePullRequestDetailScreenProps) {
  return (
    <PullRequestDetail
      pullRequest={pullRequest}
      detail={detail}
      isLoading={isLoading}
      error={error}
      onRefresh={onRefresh}
      onMerged={onMerged}
      onCreateFixIssue={onCreateFixIssue}
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
