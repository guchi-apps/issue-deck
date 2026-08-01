"use client";

import { Card } from "@/components/ui/card";
import { getLabelDotStyle } from "@/lib/label-color";
import { navViewIcons, navViews } from "@/lib/nav-views";
import type { LabelSummary, NavViewId, OverviewStat } from "@/types/issue";

type MobileHomeScreenProps = {
  labelSummary: LabelSummary[];
  overviewStats: OverviewStat[];
  navCounts: Record<NavViewId, number>;
  onSelectQuickView: (view: NavViewId) => void;
};

const quickFilterViews = navViews.filter((view) => view.id !== "all");

export function MobileHomeScreen({
  labelSummary,
  overviewStats,
  navCounts,
  onSelectQuickView,
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
                <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                <p className="text-lg font-semibold">{stat.value}</p>
                {stat.diffLabel && (
                  <p className="text-[10px] text-muted-foreground">{stat.diffLabel}</p>
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
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
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
          <h2 className="mb-2 text-sm font-semibold">ラベル</h2>
          <ul className="flex flex-col gap-1">
            {labelSummary.map((label) => (
              <li key={label.name} className="flex items-center justify-between px-2 py-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    className="size-2 rounded-full ring-1 ring-inset ring-border"
                    style={getLabelDotStyle(label.color)}
                  />
                  {label.name}
                </span>
                <span className="text-xs text-muted-foreground">{label.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
