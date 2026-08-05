"use client";

import { Plus, SlidersHorizontal, X } from "lucide-react";

import { Card } from "@/components/ui/card";
import { labelNavViews, navViewIcons, navViews } from "@/lib/nav-views";
import type { NavViewId, OverviewStat } from "@/types/issue";
import type { QuickFilter } from "@/types/quick-filter";

type MobileHomeScreenProps = {
  overviewStats: OverviewStat[];
  navCounts: Record<NavViewId, number>;
  onSelectQuickView: (view: NavViewId) => void;
  quickFilters: QuickFilter[];
  onSelectQuickFilter: (quickFilter: QuickFilter) => void;
  onDeleteQuickFilter: (quickFilter: QuickFilter) => void;
  onSaveQuickFilter: () => void;
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
  quickFilters,
  onSelectQuickFilter,
  onDeleteQuickFilter,
  onSaveQuickFilter,
}: MobileHomeScreenProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b p-4">
        <span className="text-base font-semibold">Issue Deck</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4">
          <h2 className="mb-2 text-sm font-semibold">概要</h2>
          <div className="grid grid-cols-3 gap-2">
            {overviewStats.map((stat) => (
              <Card key={stat.label} className="gap-1 p-3">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="text-lg font-semibold">{stat.value}</p>
                {stat.diffLabel && (
                  <p className="text-xs text-muted-foreground">{stat.diffLabel}</p>
                )}
              </Card>
            ))}
          </div>
        </div>

        <div className="px-4 pb-4">
          <h2 className="mb-2 text-sm font-semibold">よくつかうフィルター</h2>
          <ul className="flex flex-col gap-1">
            {quickFilterViews.map((view) => {
              const Icon = navViewIcons[view.id];
              return (
                <li key={view.id}>
                  <button
                    type="button"
                    onClick={() => onSelectQuickView(view.id)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      {view.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{navCounts[view.id]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="px-4 pb-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">保存したフィルター</h2>
            <button
              type="button"
              onClick={onSaveQuickFilter}
              className="-m-2 rounded-full p-2 text-muted-foreground hover:text-foreground active:bg-muted"
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
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{quickFilter.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteQuickFilter(quickFilter)}
                    title="削除"
                    aria-label={`${quickFilter.name}を削除`}
                    className="shrink-0 rounded-md p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground"
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
