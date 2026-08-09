"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import { ArrowLeft, MessageCircleQuestion, Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { SWIPE_THRESHOLD_PX, useSwipeFilterView } from "@/hooks/use-swipe-filter-view";
import { baseNavViews, getAdjacentNavViewId, labelNavViews } from "@/lib/nav-views";
import { cn } from "@/lib/utils";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";

// 一覧画面上部のフィルタータブは「すべてのIssue」の右隣にユーザーの確認待ちを固定表示し、
// 対応が必要なIssueを横スクロールなしで見つけられるようにする（#714）。
// 「お気に入り」「最近追加した」はスマホの一覧画面では表示しない（#873）。
const tabNavViews = [baseNavViews[0], labelNavViews[0], ...labelNavViews.slice(1)];

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
  const swipeBackHandlers = useSwipeBack(onBack ?? (() => {}));
  const swipeFilterHandlers = useSwipeFilterView((direction) => {
    // タブの表示順（tabNavViews）で隣接判定する。navViews順のままだと、
    // #714でタブ上「すべてのIssue」の右隣に固定表示したユーザー確認待ちタブへ
    // スワイプしても隣接扱いされず、表示順とスワイプの挙動がズレてしまう（#734）。
    const nextView = getAdjacentNavViewId(view, direction, tabNavViews);
    if (nextView) onChangeView(nextView);
  });
  const tabRefs = useRef<Partial<Record<NavViewId, HTMLButtonElement | null>>>({});

  // Issue一覧本体のドラッグ追従（swipeFilterHandlers.style）と足並みを揃え、
  // タブのハイライトもドラッグ量に応じて隣接タブへクロスフェードさせる（#924）。
  const { dragX, isDragging } = swipeFilterHandlers;
  const dragProgress = Math.min(Math.abs(dragX) / SWIPE_THRESHOLD_PX, 1);
  const previewView =
    dragX !== 0 ? getAdjacentNavViewId(view, dragX < 0 ? "next" : "prev", tabNavViews) : null;
  const tabOverlayTransition = isDragging ? "none" : "opacity 0.2s ease-out";

  useEffect(() => {
    tabRefs.current[view]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view]);

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
          <p className="text-xs text-muted-foreground">
            {meta ? `${meta}・${issues.length}件` : `${issues.length}件`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterSheetOpen(true)}
            className="flex size-11 items-center justify-center rounded-md border"
            aria-label="絞り込み・並び替え"
          >
            <SlidersHorizontal className="size-4" />
          </button>
          {headerActions}
        </div>
      </header>

      {/* isolate/[contain:paint]は#473でring枠線のiOS Safari描画崩れ対策として付与したが、
          #506でring自体を塗りつぶし背景に置き換えたため役目を終えていた。むしろ親の
          h-dvh（#304でフッター隠れ対策として導入、Safariのツールバー開閉のたびに再計算される）
          の変化を受けるたびにペイントコンテインメントの再計算が発生し、崩れを誘発し得るため削除する（#547）。
          その後#604で親のh-dvhはh-fullに置き換え、body側（#304で固定サイズ済み）に追従させた */}
      {/* shrink-0がないと、下のIssueList（flex-1でflex-basisが0のため縮小分を負担しない）の
          分まで縮小配分がこの行に集中し、表示件数が多いときにタブの高さが潰れてしまう（#584） */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b p-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabNavViews.map((navView) => {
          const count = navCounts[navView.id] ?? 0;
          const isCheckUserHighlighted = navView.id === "check-user" && count > 0;
          const badgeClassName = cn(
            "text-xs text-muted-foreground",
            isCheckUserHighlighted &&
              "flex size-5 items-center justify-center rounded-full bg-amber-500 text-white",
          );
          // 選択状態の見た目（オーバーレイ）は隣接タブへドラッグ量に応じてクロスフェードする。
          // previewViewがある間は選択中タブがフェードアウトし、隣接タブがフェードインする（#924）。
          const overlayOpacity =
            navView.id === view
              ? previewView
                ? 1 - dragProgress
                : 1
              : navView.id === previewView
                ? dragProgress
                : 0;
          return (
            <div key={navView.id} className="relative shrink-0">
              <button
                ref={(el) => {
                  tabRefs.current[navView.id] = el;
                }}
                type="button"
                onClick={() => onChangeView(navView.id)}
                className={cn(
                  "flex h-10 shrink-0 items-center gap-1.5 rounded-full border bg-background px-4 text-sm whitespace-nowrap text-muted-foreground",
                  isCheckUserHighlighted &&
                    "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-500",
                )}
              >
                {navView.label}
                <span className={badgeClassName}>{count}</span>
              </button>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className={cn(
                  "pointer-events-none absolute inset-0 flex h-10 shrink-0 items-center gap-1.5 rounded-full border bg-background px-4 text-sm whitespace-nowrap text-muted-foreground",
                  "border-primary/20 bg-primary/10 text-primary",
                  isCheckUserHighlighted &&
                    "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-500",
                )}
                style={{ opacity: overlayOpacity, transition: tabOverlayTransition }}
              >
                {navView.label}
                <span className={badgeClassName}>{count}</span>
              </button>
            </div>
          );
        })}
      </div>

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
      />

      {children}

      <div className="absolute right-4 bottom-4 flex items-center gap-2">
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
