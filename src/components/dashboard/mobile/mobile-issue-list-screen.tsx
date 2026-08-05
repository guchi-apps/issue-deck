"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { navViews } from "@/lib/nav-views";
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
  selectedIssueId: string | null;
  view: NavViewId;
  filters: MobileIssueLocalFilters;
  labelOptions: LabelSummary[];
  assigneeOptions: string[];
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
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
  selectedIssueId,
  view,
  filters,
  labelOptions,
  assigneeOptions,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onCreateIssue,
  children,
}: MobileIssueListScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const swipeBackHandlers = useSwipeBack(onBack ?? (() => {}));

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      {...(onBack ? swipeBackHandlers : {})}
    >
      <header className="flex items-center gap-2 border-b p-4">
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
          の変化を受けるたびにペイントコンテインメントの再計算が発生し、崩れを誘発し得るため削除する（#547） */}
      <div className="flex items-center gap-2 overflow-x-auto border-b p-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {navViews.map((navView) => (
          <button
            key={navView.id}
            type="button"
            onClick={() => onChangeView(navView.id)}
            className={cn(
              "flex h-11 shrink-0 items-center rounded-full bg-muted px-4 text-sm whitespace-nowrap text-muted-foreground",
              view === navView.id && "bg-primary/10 text-primary",
            )}
          >
            {navView.label}
          </button>
        ))}
      </div>

      <IssueList
        title={title}
        issues={issues}
        selectedIssueId={selectedIssueId}
        onSelectIssue={onSelectIssue}
        showSearch={false}
        showHeader={false}
        className="flex-1"
        fabSpacing
      />

      <MobileIssueFilterSheet
        open={filterSheetOpen}
        onOpenChange={setFilterSheetOpen}
        filters={filters}
        onChange={onChangeFilters}
        labelOptions={labelOptions}
        assigneeOptions={assigneeOptions}
        showLabelPresets={false}
      />

      {children}

      <button
        type="button"
        onClick={onCreateIssue}
        aria-label="新しいIssueを作成"
        className="absolute right-4 bottom-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-5" />
      </button>
    </div>
  );
}
