"use client";

import { ChevronLeft } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { pullRequestViewIcons, pullRequestViews } from "@/lib/pull-request-views";
import { cn } from "@/lib/utils";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

type MobilePullRequestsScreenProps = {
  view: PullRequestViewId;
  /** ビューごとの件数（#1389）。nullのビュー（「全てのPR」）は件数を出さない */
  navCounts: PullRequestNavCounts;
  /**
   * この画面へ来た経路（#1436）。フッターのタブから開いた場合（"tab"）は戻る先が無いため
   * 戻るボタンを出さない。ホームの「Pull Request」からのドリルダウン（"home"）でのみ出す。
   */
  origin: "tab" | "home";
  pullRequests: PullRequestSummary[];
  failedRepositories: string[];
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
  /** 画面内のタブで状態別ビューを切り替えたとき（#1436） */
  onChangeView: (view: PullRequestViewId) => void;
  /** PRを選んだとき。スマホでは同じ画面枠のままPR詳細へ切り替える（#1087） */
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onMerged: (pullRequest: PullRequestSummary) => void;
};

/**
 * スマホのPR一覧画面（#1058）。PC版と同じ`PullRequestList`をそのまま使い、ヘッダー左の
 * 戻る導線とヘッダー下のビュー切り替えタブだけを差し込む（一覧の中身に画面幅固有の
 * 出し分けが無いため）。タブの見た目はIssue一覧（`mobile-issue-list-screen.tsx`）に揃えている。
 */
export function MobilePullRequestsScreen({
  view,
  navCounts,
  origin,
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  error,
  onRefresh,
  onBack,
  onChangeView,
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
        origin === "home" ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            aria-label="戻る"
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : undefined
      }
      headerActions={<MobileDispatchStatusButton />}
      headerBelow={
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b p-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {pullRequestViews.map((pullRequestView) => {
            const Icon = pullRequestViewIcons[pullRequestView.id];
            const count = navCounts[pullRequestView.id];
            const selected = pullRequestView.id === view;
            return (
              <button
                key={pullRequestView.id}
                type="button"
                onClick={() => onChangeView(pullRequestView.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex h-10 shrink-0 items-center gap-1.5 rounded-full border bg-background px-4 text-sm whitespace-nowrap text-muted-foreground",
                  selected && "border-primary/20 bg-primary/10 text-primary",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {pullRequestView.label}
                {count !== null && <span className="text-xs text-muted-foreground">{count}</span>}
              </button>
            );
          })}
        </div>
      }
    />
  );
}
