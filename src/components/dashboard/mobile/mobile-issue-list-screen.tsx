"use client";

import { useMemo, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import { ArrowLeft, ChevronUp, MessageCircleQuestion, Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueViewSheet } from "@/components/dashboard/mobile/mobile-issue-view-sheet";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { SWIPE_THRESHOLD_PX, useSwipeFilterView } from "@/hooks/use-swipe-filter-view";
import { describeAutoRefreshState, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { formatTimeOfDay } from "@/lib/format-date-time";
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
import {
  formatManualStepListCount,
  type ManualStepReadinessMap,
} from "@/lib/manual-step-attention";
import { formatCheckUserListCount } from "@/lib/check-user-attention";
import { formatQuestionListCount } from "@/lib/question-attention";
import { cn } from "@/lib/utils";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";

type MobileIssueListScreenProps = {
  /**
   * ヘッダーに出す画面名（Issueタブなら「Issue」、リポジトリ別ならリポジトリ名）。
   * Issue以外も並ぶビューではビュー名が渡ってくる（#2081。`navViewIsUserActionList`）。
   * その場合、下の行はビュー名を重ねずに件数だけを出す。
   */
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
  /**
   * 指定時は「複数リポジトリに質問する」FABをあわせて表示する（#1454）。
   * 単一リポジトリへの質問は「＋」の新規作成（種別「質問」）へ統合済み（#1641）。
   */
  onAskCrossRepoQuestion?: () => void;
  /**
   * 特定のビューでだけ一覧の先頭に固定表示する要素と、その件数（#1713）。
   * 「ユーザーの確認待ち」でユーザーのマージを待っているPull Requestを出すのに使う。
   *
   * **`count`は表示件数へ必ず合流させる。** ホーム画面の「要対応」とメニューの
   * 「ユーザーの確認待ち」はIssueとマージ待ちPRを足した数を出しているため、ここで足さないと
   * 「2件と出ているのに開くと何も無い」という食い違いになる。合流先は`view`に一致する
   * ビューの件数だけで、他のビューの件数には触らない。
   */
  pinned?: { view: NavViewId; count: number; section: ReactNode };
  /**
   * 手作業Issue（`71.manual-step`）が、いま実行できるかどうか（#1763）。
   * ヘッダーの件数と一覧の行のアイコンに使う。母集団は絞り込み前の全Issue。
   */
  prerequisiteReadiness?: ManualStepReadinessMap;
  /**
   * 確認待ちのうち、まだエージェントが動いていて押せる操作が無いIssueのid（#2174）。
   * ヘッダーの件数の内訳（`2件・実行中1件`）にだけ使い、行は今までどおり並べる。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  /** 手作業アシスタント（#1826）を開く。「ユーザーの作業待ち」でだけ使う */
  onStartManualStepGuide?: (startIssueId?: string) => void;
  /** 「次にやること」（#1853）を開く。出すかどうかの判定は`IssueList`が行う */
  onStartIssueOrder?: () => void;
  /** コードレビュー（#698）を実行するダイアログを開く。「コードレビュー」ビューでだけ出る */
  onStartCodeReview?: () => void;
  issueOrderAutoStart?: boolean;
  issueOrderCount?: number;
  /** Issue一覧のスクロール位置を保存・復元する単位を表すキー（#773） */
  scrollKey: string;
  /**
   * 一覧を下へ引っ張ったときのIssueの取り直し（#1893）。渡さないと引っ張り更新は動かない。
   * ヘッダーの実行状況（`useDispatchState`）はこの画面が持っているため、ここで一緒に撃つ。
   */
  onRefresh?: () => Promise<unknown> | void;
  /** 最終取得時刻（ISO8601）。件数の行に「HH:MM時点」として出す（#1797） */
  fetchedAt?: string | null;
  /**
   * 自動更新の間隔（#1797）。`null`＝自動更新しない。渡さない一覧はこの状態を出さない。
   * PCの一覧・PR一覧・ブランチ画面と同じ文言で、`describeAutoRefreshState`から作る。
   */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
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
  onAskCrossRepoQuestion,
  pinned,
  prerequisiteReadiness,
  checkUserRunningIssueIds,
  onStartManualStepGuide,
  onStartIssueOrder,
  onStartCodeReview,
  issueOrderAutoStart,
  issueOrderCount,
  scrollKey,
  onRefresh,
  fetchedAt = null,
  autoRefreshIntervalMs,
  children,
}: MobileIssueListScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [viewSheetOpen, setViewSheetOpen] = useState(false);

  // 固定表示ぶんを件数へ合流させる（#1713）。ヘッダーの「N件」は表示中のビューの分だけ、
  // ビュー行・ビュー選択シートの件数は対象のビューの分を足す（スワイプ中に見える隣の
  // ビューの件数も、切り替えた後と同じ数字にするため）。
  const pinnedCount = pinned?.count ?? 0;
  const listedCount = issues.length + (pinned?.view === view ? pinnedCount : 0);
  // 「ユーザーの作業待ち」だけは、メニューと同じ「いま実行できる件数」に前提待ちを添える
  // （#1763）。スマホはアイコンにカーソルを合わせられないため、内訳を読めるのはここだけ。
  // 「質問」の未確認の内訳（#1796）も同じ理由でここに出す（PCの一覧ヘッダーと同じ表記）
  // 「ユーザーの確認待ち」も同じ形で、実行中のぶんを差として添える（#2174）
  const checkUserRunningCount =
    view === "check-user" && checkUserRunningIssueIds
      ? issues.filter((issue) => checkUserRunningIssueIds.has(issue.id)).length
      : 0;
  const countLabel =
    (view === "manual-step" && prerequisiteReadiness
      ? formatManualStepListCount(issues, prerequisiteReadiness)
      : null) ??
    (view === "question" ? formatQuestionListCount(issues, listedCount) : null) ??
    formatCheckUserListCount(listedCount, checkUserRunningCount) ??
    `${listedCount}件`;
  const displayNavCounts = useMemo(() => {
    if (!pinned || pinned.count === 0) return navCounts;
    return { ...navCounts, [pinned.view]: (navCounts[pinned.view] ?? 0) + pinned.count };
  }, [navCounts, pinned]);

  // ホーム画面のクイックビューから、一覧では選べないビュー（本番反映待ちなど）で開かれる
  // ことがあるため、そのビューだけは一時的に足す（#1645）。
  const navViewsForList = useMemo(() => resolveMobileListNavViews(view), [view]);

  // ヘッダーの実行状況（#1638）と一覧の実行先の解決（#1262）が同じものを見るため、
  // この画面で1回だけ取って両方へ配る（取得口を増やさない＝`use-dispatch-state.ts`の取り決め）
  const dispatch = useDispatchState(true);

  // 一覧を下へ引っ張ったときの更新（#1893）。**待つのはIssueの取り直しだけ。**
  // `dispatch.refresh`は取り直しの合図（`reloadKey`を進める同期関数）で完了を待てないが、
  // 更新中の表示は`MIN_REFRESHING_MS`（0.5秒）保たれるので、その間に反映される。
  async function handlePullToRefresh() {
    dispatch.refresh();
    await onRefresh?.();
  }

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

  const viewLabel = getNavViewLabel(view);
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
              一覧をスクロールしている最中に「何を見ているのか」を見上げて確かめられる。
              **見出しが既にビュー名のときは重ねない**（#2081）。Issueだけの一覧ではない
              ビューは見出しをビュー名へ差し替えており、そのまま出すと同じ言葉が2行並ぶ */}
          {/* いつ時点の内容かと自動更新の状態も、PCの一覧・PR一覧・ブランチ画面と同じ並びで
              足す（#1797）。**先頭は今までどおりビュー名と件数**で、幅が足りなければ
              後ろから省略される（追加ぶんが押し出すのは追加ぶん自身） */}
          <p className="truncate text-xs text-muted-foreground">
            {[
              meta,
              viewLabel === title ? null : viewLabel,
              countLabel,
              fetchedAt ? `${formatTimeOfDay(fetchedAt)}時点` : null,
              autoRefreshIntervalMs === undefined
                ? null
                : describeAutoRefreshState(autoRefreshIntervalMs),
            ]
              .filter(Boolean)
              .join("・")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          {/* 実行状況（#1638）。画面固有の操作の右隣＝ヘッダーの右端で全画面そろえる */}
          <MobileDispatchStatusButton dispatch={dispatch} />
          {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
          <MobileNotificationButton />
        </div>
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
        dispatch={dispatch}
        // ユーザーがマージするしかないPRは、確認待ちの一覧の先頭に出す（#1613・#1713）。
        // PC（`issue-deck-shell.tsx`のIssueList）と同じ位置・同じ内容にする
        pinnedSection={pinned?.view === view ? pinned.section : undefined}
        prerequisiteReadiness={prerequisiteReadiness}
        checkUserRunningIssueIds={checkUserRunningIssueIds}
        onStartManualStepGuide={onStartManualStepGuide}
        onStartIssueOrder={onStartIssueOrder}
        onStartCodeReview={onStartCodeReview}
        issueOrderAutoStart={issueOrderAutoStart}
        issueOrderCount={issueOrderCount}
        onPullToRefresh={onRefresh ? handlePullToRefresh : undefined}
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
              <span className="truncate font-medium">{viewLabel}</span>
              <span className="shrink-0 text-xs text-primary/70">
                {displayNavCounts[view] ?? 0}
              </span>
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
                  {displayNavCounts[previewView.id] ?? 0}
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
        navCounts={displayNavCounts}
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

      {/* 下端の絞り込み行（高さ約74px）と重ならない位置へ上げる（#1645）。
          z-20は一覧の行より手前に浮かせるため（#1945）。一覧の行は中身の重なり順に
          z-indexを使っており、指定が無いとスクロール中にこのボタンが行の後ろへ回る */}
      <div className="absolute right-4 bottom-22 z-20 flex items-center gap-3">
        {onAskCrossRepoQuestion && (
          <button
            type="button"
            onClick={onAskCrossRepoQuestion}
            aria-label="複数リポジトリに質問する"
            className="flex size-14 items-center justify-center rounded-full border bg-background shadow-lg"
          >
            <MessageCircleQuestion className="size-6" />
          </button>
        )}
        <button
          type="button"
          onClick={onCreateIssue}
          aria-label="新しいIssueを作成"
          className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
        >
          <Plus className="size-6" />
        </button>
      </div>
    </div>
  );
}
