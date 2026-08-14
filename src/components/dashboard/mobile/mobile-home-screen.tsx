"use client";

import { FolderGit2, Plus, SlidersHorizontal, X } from "lucide-react";

import { Card } from "@/components/ui/card";
import { labelNavViews, navViewIcons, navViews } from "@/lib/nav-views";
import { pullRequestViewIcons, pullRequestViews } from "@/lib/pull-request-views";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { NavViewId, OverviewStat } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { QuickFilter } from "@/types/quick-filter";
import type { ConnectedRepository } from "@/types/repository";

type MobileHomeScreenProps = {
  overviewStats: OverviewStat[];
  navCounts: Record<NavViewId, number>;
  onSelectQuickView: (view: NavViewId) => void;
  favoriteRepositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
  quickFilters: QuickFilter[];
  onSelectQuickFilter: (quickFilter: QuickFilter) => void;
  onDeleteQuickFilter: (quickFilter: QuickFilter) => void;
  onSaveQuickFilter: () => void;
  onSelectPullRequests: (view: PullRequestViewId) => void;
};

// 運用ラベルのビュー（ユーザーの確認待ちなど）を先に、「すべてのIssue」を除いた
// 残りのビューを後ろに並べる。
const quickFilterViews = [
  ...labelNavViews,
  ...navViews.filter((view) => view.id !== "all" && !view.labels),
];

export function MobileHomeScreen({
  overviewStats,
  navCounts,
  onSelectQuickView,
  favoriteRepositories,
  onSelectRepository,
  quickFilters,
  onSelectQuickFilter,
  onDeleteQuickFilter,
  onSaveQuickFilter,
  onSelectPullRequests,
}: MobileHomeScreenProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b p-4">
        <span className="text-base font-semibold">Issue Deck</span>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="p-4">
          <h2 className="mb-2 text-sm font-semibold">概要</h2>
          <div className="grid grid-cols-3 gap-2">
            {overviewStats.map((stat) =>
              stat.linkedView ? (
                <button
                  key={stat.label}
                  type="button"
                  onClick={() => onSelectQuickView(stat.linkedView as NavViewId)}
                  className="w-full text-left"
                >
                  <Card className="gap-1 p-3 hover:bg-accent active:bg-accent">
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="text-lg font-semibold">{stat.value}</p>
                    {stat.diffLabel && (
                      <p className="text-xs text-muted-foreground">{stat.diffLabel}</p>
                    )}
                  </Card>
                </button>
              ) : (
                <Card key={stat.label} className="gap-1 p-3">
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className="text-lg font-semibold">{stat.value}</p>
                  {stat.diffLabel && (
                    <p className="text-xs text-muted-foreground">{stat.diffLabel}</p>
                  )}
                </Card>
              ),
            )}
          </div>
        </div>

        <div className="px-4 pb-4">
          <h2 className="mb-2 text-sm font-semibold">よくつかうフィルター</h2>
          <ul className="flex flex-col gap-1">
            {quickFilterViews.map((view) => {
              const Icon = navViewIcons[view.id];
              // ユーザーの確認待ちが1件以上あるときは、ヘッダー下フィルターと
              // 同じ配色（amber）で強調する（#742）。
              const isCheckUserHighlighted = view.id === "check-user" && navCounts[view.id] > 0;
              return (
                <li key={view.id}>
                  <button
                    type="button"
                    onClick={() => onSelectQuickView(view.id)}
                    className={cn(
                      "flex min-h-11 w-full items-center justify-between rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent",
                      isCheckUserHighlighted && "bg-amber-500/10 text-amber-600 dark:text-amber-500",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className={cn(
                          "size-3.5 text-muted-foreground",
                          isCheckUserHighlighted && "text-amber-600 dark:text-amber-500",
                        )}
                      />
                      {view.label}
                    </span>
                    <span
                      className={cn(
                        "text-xs text-muted-foreground",
                        isCheckUserHighlighted &&
                          "flex size-5 items-center justify-center rounded-full bg-amber-500 text-white",
                      )}
                    >
                      {navCounts[view.id]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="px-4 pb-4">
          <h2 className="mb-2 text-sm font-semibold">Pull Request</h2>
          <ul className="flex flex-col gap-1">
            {pullRequestViews.map((view) => {
              const Icon = pullRequestViewIcons[view.id];
              return (
                <li key={view.id}>
                  <button
                    type="button"
                    onClick={() => onSelectPullRequests(view.id)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    {view.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {favoriteRepositories.length > 0 && (
          <div className="px-4 pb-4">
            <h2 className="mb-2 text-sm font-semibold">お気に入りリポジトリ</h2>
            <ul className="flex flex-col gap-1">
              {favoriteRepositories.map((repo) => {
                const color = getRepoColor(repo.fullName);
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => onSelectRepository(repo)}
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                    >
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        <FolderGit2 className="size-3.5" />
                      </span>
                      <span className="truncate">{repo.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="px-4 pb-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">保存したフィルター</h2>
            <button
              type="button"
              onClick={onSaveQuickFilter}
              className="-m-3.5 rounded-full p-3.5 text-muted-foreground hover:text-foreground active:bg-muted"
              title="現在の検索条件を保存"
              aria-label="現在の検索条件を保存"
            >
              <Plus className="size-4" />
            </button>
          </div>
          {quickFilters.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">
              よく使う検索条件を保存できます
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {quickFilters.map((quickFilter) => (
                <li key={quickFilter.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelectQuickFilter(quickFilter)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{quickFilter.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteQuickFilter(quickFilter)}
                    title="削除"
                    aria-label={`${quickFilter.name}を削除`}
                    className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
