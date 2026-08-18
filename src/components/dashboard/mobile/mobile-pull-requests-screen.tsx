"use client";

import { useState } from "react";
import type { TouchEvent } from "react";
import { ChevronLeft, ChevronUp } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { MobileViewSheet } from "@/components/dashboard/mobile/mobile-view-sheet";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { SWIPE_THRESHOLD_PX, useSwipeFilterView } from "@/hooks/use-swipe-filter-view";
import type { AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import {
  getAdjacentPullRequestViewId,
  getPullRequestView,
  pullRequestViewIcons,
  pullRequestViews,
} from "@/lib/pull-request-views";
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
  /** 自動更新も含めて取得中か（#1767）。`PullRequestList`へそのまま渡す */
  isRefreshing: boolean;
  /** 自動更新の間隔（#1767）。`PullRequestList`へそのまま渡す */
  autoRefreshIntervalMs: AutoRefreshIntervalMs;
  error: string | null;
  onRefresh: () => void;
  onBack: () => void;
  /** 画面内で状態別ビューを切り替えたとき（#1436） */
  onChangeView: (view: PullRequestViewId) => void;
  /** PRを選んだとき。スマホでは同じ画面枠のままPR詳細へ切り替える（#1087） */
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onMerged: (pullRequest: PullRequestSummary) => void;
};

/**
 * スマホのPR一覧画面（#1058）。PC版と同じ`PullRequestList`をそのまま使い、ヘッダー左の
 * 戻る導線と、下端のビュー切り替え行だけを差し込む（一覧の中身に画面幅固有の
 * 出し分けが無いため）。
 *
 * ビューの切り替えはIssue一覧（`mobile-issue-list-screen.tsx`）と同じ形に揃えている（#1691）。
 * 元はヘッダー下の横スクロールタブだったが、片手で持つと親指が届かず、押して開くシートは
 * 下から出るため視線と指が上下に往復していた。下端の行と左右スワイプなら親指の届く範囲で完結する。
 */
export function MobilePullRequestsScreen({
  view,
  navCounts,
  origin,
  pullRequests,
  failedRepositories,
  fetchedAt,
  isLoading,
  isRefreshing,
  autoRefreshIntervalMs,
  error,
  onRefresh,
  onBack,
  onChangeView,
  onSelectPullRequest,
  onMerged,
}: MobilePullRequestsScreenProps) {
  const [viewSheetOpen, setViewSheetOpen] = useState(false);

  // 戻るボタンを出す経路（ホームからのドリルダウン）でだけ、戻るスワイプも有効にする
  const backEnabled = origin === "home";
  const swipeBackHandlers = useSwipeBack(onBack);
  const swipeFilterHandlers = useSwipeFilterView((direction) => {
    const nextView = getAdjacentPullRequestViewId(view, direction);
    if (nextView) onChangeView(nextView);
  });

  // 一覧本体のドラッグ追従（swipeFilterHandlers.style）と足並みを揃え、下端のビュー行の
  // 表示もドラッグ量に応じて隣のビューへクロスフェードさせる（#924と同じ扱い）。
  const { dragX, isDragging } = swipeFilterHandlers;
  const dragProgress = Math.min(Math.abs(dragX) / SWIPE_THRESHOLD_PX, 1);
  const previewViewId =
    dragX !== 0 ? getAdjacentPullRequestViewId(view, dragX < 0 ? "next" : "prev") : null;
  const previewView = previewViewId ? getPullRequestView(previewViewId) : null;
  const viewOverlayTransition = isDragging ? "none" : "opacity 0.2s ease-out";

  const ViewIcon = pullRequestViewIcons[view];
  const PreviewViewIcon = previewView ? pullRequestViewIcons[previewView.id] : null;
  const count = navCounts[view];
  const previewCount = previewView ? navCounts[previewView.id] : null;

  // 戻るスワイプとビュー切り替えスワイプは同じ領域で発生するため、2フックのハンドラを
  // 1つのtouchイベントハンドラ群に統合して同じ要素に付与する
  // （別々にバインドすると、互いのドラッグ用スタイルが競合する）。
  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    if (backEnabled) swipeBackHandlers.onTouchStart(e);
    swipeFilterHandlers.onTouchStart(e);
  }
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (backEnabled) swipeBackHandlers.onTouchMove(e);
    swipeFilterHandlers.onTouchMove(e);
  }
  function onTouchEnd() {
    if (backEnabled) swipeBackHandlers.onTouchEnd();
    swipeFilterHandlers.onTouchEnd();
  }
  function onTouchCancel() {
    if (backEnabled) swipeBackHandlers.onTouchCancel();
    swipeFilterHandlers.onTouchCancel();
  }

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      style={backEnabled ? swipeBackHandlers.style : undefined}
    >
      <PullRequestList
        view={view}
        pullRequests={pullRequests}
        failedRepositories={failedRepositories}
        fetchedAt={fetchedAt}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        autoRefreshIntervalMs={autoRefreshIntervalMs}
        error={error}
        onRefresh={onRefresh}
        onSelectPullRequest={onSelectPullRequest}
        onMerged={onMerged}
        className="h-full"
        listStyle={swipeFilterHandlers.style}
        footerSpacing
        headerLeading={
          backEnabled ? (
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
        headerActions={
          <>
            <MobileDispatchStatusButton />
            {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
            <MobileNotificationButton />
          </>
        }
        footer={
          /* ビューを切り替える行は画面の下端（フッタータブのすぐ上）に置く（#1691）。
             shrink-0がないと一覧（flex-1）の縮小分がこの行に集中して高さが潰れる（#584） */
          <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 pt-1.5 pb-3">
            {/* いくつのビューの何番目にいるかを示す。左右スワイプで移動できることの合図も兼ねる */}
            <div className="flex items-center justify-center gap-1" aria-hidden>
              {pullRequestViews.map((pullRequestView) => (
                <span
                  key={pullRequestView.id}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    pullRequestView.id === view
                      ? "w-3.5 bg-primary/60"
                      : "w-1.5 bg-muted-foreground/30",
                  )}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() => setViewSheetOpen(true)}
              aria-haspopup="dialog"
              className="relative flex h-11 w-full min-w-0 items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3.5 text-sm text-primary"
            >
              {/* スワイプ中は、隣のビューの表示へドラッグ量に応じてクロスフェードする */}
              <span
                className="flex min-w-0 flex-1 items-center gap-2"
                style={{
                  opacity: previewView ? 1 - dragProgress : 1,
                  transition: viewOverlayTransition,
                }}
              >
                <ViewIcon className="size-4 shrink-0" />
                <span className="truncate font-medium">{getPullRequestView(view).label}</span>
                {count !== null && <span className="shrink-0 text-xs text-primary/70">{count}</span>}
              </span>
              {previewView && PreviewViewIcon && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-9 left-3.5 flex items-center gap-2"
                  style={{ opacity: dragProgress, transition: viewOverlayTransition }}
                >
                  <PreviewViewIcon className="size-4 shrink-0" />
                  <span className="truncate font-medium">{previewView.label}</span>
                  {previewCount !== null && (
                    <span className="shrink-0 text-xs text-primary/70">{previewCount}</span>
                  )}
                </span>
              )}
              <ChevronUp className="size-4 shrink-0 text-primary/60" />
            </button>
          </div>
        }
      />

      <MobileViewSheet
        open={viewSheetOpen}
        onOpenChange={setViewSheetOpen}
        title="表示するPull Request"
        items={pullRequestViews.map((pullRequestView) => ({
          id: pullRequestView.id,
          label: pullRequestView.label,
          icon: pullRequestViewIcons[pullRequestView.id],
          count: navCounts[pullRequestView.id],
        }))}
        selectedId={view}
        onSelect={onChangeView}
      />
    </div>
  );
}
