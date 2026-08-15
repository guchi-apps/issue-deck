"use client";

import { useMemo, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import { ArrowLeft, ChevronUp, MessageCircleQuestion, Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueViewSheet } from "@/components/dashboard/mobile/mobile-issue-view-sheet";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { SWIPE_THRESHOLD_PX, useSwipeFilterView } from "@/hooks/use-swipe-filter-view";
import {
  clearIssueFilterConditions,
  countActiveIssueFilters,
} from "@/lib/issue-filter-summary";
import {
  getAdjacentNavViewId,
  getNavView,
  getNavViewLabel,
  navViewIcons,
  resolveMobileListNavViews,
} from "@/lib/nav-views";
import { cn } from "@/lib/utils";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";

type MobileIssueListScreenProps = {
  /** ヘッダーに出す画面名（Issueタブなら「Issue」、リポジトリ別ならリポジトリ名） */
  title: string;
  /** タイトル左のアイコン（リポジトリ別一覧のみ） */
  icon?: ReactNode;
  /** 件数の前に添える補足（リポジトリ別一覧のPrivate/Public） */
  meta?: string;
  /** 指定時はヘッダーに戻るボタンを出し、スワイプバックも有効にする */
  onBack?: () => void;
  /** 絞り込みボタンの右に並べる画面固有のアクション（リリースボタン等） */
  headerActions?: ReactNode;
  /** 絞り込み済み・並び替え済みの表示対象Issue */
  issues: Issue[];
  /** タブごとの該当Issue件数。「ユーザーの確認待ち」の強調表示判定にも使う（#715, #880） */
  navCounts: Record<NavViewId, number>;
  selectedIssueId: string | null;
  view: NavViewId;
  filters: MobileIssueLocalFilters;
  labelOptions: LabelSummary[];
  assigneeOptions: string[];
  /**
   * リポジトリごとのグルーピング表示（#849）のON/OFF。単一リポジトリの一覧
   * （リポジトリ別画面）では対象外のため省略でき、その場合は常にフラット表示になる。
   */
  groupByRepo?: boolean;
  onChangeGroupByRepo?: (value: boolean) => void;
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
  /** 指定時は「リポジトリに質問する」FABをあわせて表示する（#691） */
  onAskQuestion?: () => void;
  /** Issue一覧のスクロール位置を保存・復元する単位を表すキー（#773） */
  scrollKey: string;
  /** 画面固有のシート等（リリースシート） */
  children?: ReactNode;
};

// スマホのIssue一覧画面（Issueタブ／リポジトリ別）の共通レイアウト。
// 遷移経路によってヘッダーの段数やクイックビューの有無が違い、同じ一覧なのに
// 別画面のように見えていたため、両画面をこのコンポーネントに統一した（#414）。
export function MobileIssueListScreen({
  title,
  icon,
  meta,
  onBack,
  headerActions,
  issues,
  navCounts,
  selectedIssueId,
  view,
  filters,
  labelOptions,
  assigneeOptions,
  groupByRepo = false,
  onChangeGroupByRepo,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onCreateIssue,
  onAskQuestion,
  scrollKey,
  children,
}: MobileIssueListScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [viewSheetOpen, setViewSheetOpen] = useState(false);

  // ホーム画面のクイックビューから、一覧では選べないビュー（本番反映待ちなど）で開かれる
  // ことがあるため、そのビューだけは一時的に足す（#1645）。
  const navViewsForList = useMemo(() => resolveMobileListNavViews(view), [view]);

  const swipeBackHandlers = useSwipeBack(onBack ?? (() => {}));
  const swipeFilterHandlers = useSwipeFilterView((direction) => {
    // 一覧での表示順（navViewsForList）で隣接判定する。navViews順のままだと、
    // #714で「すべてのIssue」の次に固定したユーザー確認待ちへスワイプしても隣接扱いされず、
    // 表示順とスワイプの挙動がズレてしまう（#734）。
    const nextView = getAdjacentNavViewId(view, direction, navViewsForList);
    if (nextView) onChangeView(nextView);
  });

  // Issue一覧本体のドラッグ追従（swipeFilterHandlers.style）と足並みを揃え、
  // ビュー選択ボタンの表示もドラッグ量に応じて隣のビューへクロスフェードさせる（#924）。
  const { dragX, isDragging } = swipeFilterHandlers;
  const dragProgress = Math.min(Math.abs(dragX) / SWIPE_THRESHOLD_PX, 1);
  const previewViewId =
    dragX !== 0 ? getAdjacentNavViewId(view, dragX < 0 ? "next" : "prev", navViewsForList) : null;
  const previewView = previewViewId ? getNavView(previewViewId) : null;
  const viewOverlayTransition = isDragging ? "none" : "opacity 0.2s ease-out";

  const ViewIcon = navViewIcons[view];
  const PreviewViewIcon = previewView ? navViewIcons[previewView.id] : null;
  const activeFilterCount = countActiveIssueFilters(filters, view);

  // 戻るスワイプとフィルター切り替えスワイプは同じ領域で発生するため、
  // 2フックのハンドラを1つのtouchイベントハンドラ群に統合して同じ要素に付与する
  // （別々にバインドすると、互いのドラッグ用スタイルが競合する）。
  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    if (onBack) swipeBackHandlers.onTouchStart(e);
    swipeFilterHandlers.onTouchStart(e);
  }
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (onBack) swipeBackHandlers.onTouchMove(e);
    swipeFilterHandlers.onTouchMove(e);
  }
  function onTouchEnd() {
    if (onBack) swipeBackHandlers.onTouchEnd();
    swipeFilterHandlers.onTouchEnd();
  }
  function onTouchCancel() {
    if (onBack) swipeBackHandlers.onTouchCancel();
    swipeFilterHandlers.onTouchCancel();
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      style={onBack ? swipeBackHandlers.style : undefined}
    >
      <header className="flex shrink-0 items-center gap-2 border-b p-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="戻る"
            className="-my-3 -ml-3 shrink-0 rounded-full p-3 active:bg-muted"
          >
            <ArrowLeft className="size-5" />
          </button>
        )}
        {icon}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {/* 表示中のビュー名を件数の行にも出す（#1645）。操作は下端の行で行うが、
              一覧をスクロールしている最中に「何を見ているのか」を見上げて確かめられる */}
          <p className="truncate text-xs text-muted-foreground">
            {[meta, getNavViewLabel(view), `${issues.length}件`].filter(Boolean).join("・")}
          </p>
        </div>
        {headerActions && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>}
      </header>

      <IssueList
        title={title}
        issues={issues}
        selectedIssueId={selectedIssueId}
        onSelectIssue={onSelectIssue}
        showSearch={false}
        showHeader={false}
        className="flex-1"
        style={swipeFilterHandlers.style}
        fabSpacing
        footerSpacing
        scrollKey={scrollKey}
        groupByRepo={groupByRepo}
        view={view}
      />

      {/* 一覧の絞り込みを操作する行は画面の下端（フッタータブのすぐ上）に置く（#1645）。
          元は上部の横スクロールタブだったが、片手で持ったときに親指が届かないうえ、
          押して開くシートは下から出るため視線と指が上下に往復していた。
          shrink-0がないと、IssueList（flex-1でflex-basisが0のため縮小分を負担しない）の
          分まで縮小配分がこの行に集中し、表示件数が多いときに高さが潰れてしまう（#584） */}
      <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 pt-1.5 pb-3">
        {/* いくつのビューの何番目にいるかを示す。左右スワイプで移動できることの合図も兼ねる */}
        <div className="flex items-center justify-center gap-1" aria-hidden>
          {navViewsForList.map((navView) => (
            <span
              key={navView.id}
              className={cn(
                "h-1.5 rounded-full transition-all",
                navView.id === view ? "w-3.5 bg-primary/60" : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewSheetOpen(true)}
            aria-haspopup="dialog"
            className="relative flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3.5 text-sm text-primary"
          >
            {/* スワイプ中は、隣のビューの表示へドラッグ量に応じてクロスフェードする（#924） */}
            <span
              className="flex min-w-0 flex-1 items-center gap-2"
              style={{
                opacity: previewView ? 1 - dragProgress : 1,
                transition: viewOverlayTransition,
              }}
            >
              <ViewIcon className="size-4 shrink-0" />
              <span className="truncate font-medium">{getNavViewLabel(view)}</span>
              <span className="shrink-0 text-xs text-primary/70">{navCounts[view] ?? 0}</span>
            </span>
            {previewView && PreviewViewIcon && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-9 left-3.5 flex items-center gap-2"
                style={{ opacity: dragProgress, transition: viewOverlayTransition }}
              >
                <PreviewViewIcon className="size-4 shrink-0" />
                <span className="truncate font-medium">{previewView.label}</span>
                <span className="shrink-0 text-xs text-primary/70">
                  {navCounts[previewView.id] ?? 0}
                </span>
              </span>
            )}
            <ChevronUp className="size-4 shrink-0 text-primary/60" />
          </button>

          <button
            type="button"
            onClick={() => setFilterSheetOpen(true)}
            aria-haspopup="dialog"
            className={cn(
              "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm",
              // 絞り込みが効いているかどうかは、色と件数バッジの両方で示す（#1645）。
              // アイコンだけでは「件数が少ないのは絞り込んでいるからだ」と読み取れなかった。
              activeFilterCount > 0 && "border-primary/20 bg-primary/10 text-primary",
            )}
          >
            <SlidersHorizontal className="size-4" />
            絞り込み
            {activeFilterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <MobileIssueViewSheet
        open={viewSheetOpen}
        onOpenChange={setViewSheetOpen}
        views={navViewsForList}
        view={view}
        navCounts={navCounts}
        onSelect={onChangeView}
      />

      <MobileIssueFilterSheet
        open={filterSheetOpen}
        onOpenChange={setFilterSheetOpen}
        filters={filters}
        onChange={onChangeFilters}
        labelOptions={labelOptions}
        assigneeOptions={assigneeOptions}
        showLabelPresets={false}
        sortLocked={view === "check-user"}
        groupByRepo={groupByRepo}
        onChangeGroupByRepo={onChangeGroupByRepo}
        activeFilterCount={activeFilterCount}
        onClearFilters={() => onChangeFilters(clearIssueFilterConditions(filters, view))}
      />

      {children}

      {/* 下端の絞り込み行（高さ約74px）と重ならない位置へ上げる（#1645） */}
      <div className="absolute right-4 bottom-22 flex items-center gap-2">
        {onAskQuestion && (
          <button
            type="button"
            onClick={onAskQuestion}
            aria-label="リポジトリに質問する"
            className="flex size-12 items-center justify-center rounded-full border bg-background shadow-lg"
          >
            <MessageCircleQuestion className="size-5" />
          </button>
        )}
        <button
          type="button"
          onClick={onCreateIssue}
          aria-label="新しいIssueを作成"
          className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
        >
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}
