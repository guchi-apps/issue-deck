"use client";

import { Card } from "@/components/ui/card";
import { getLabelDotStyle } from "@/lib/label-color";
import type { LabelSummary, OverviewStat } from "@/types/issue";

type MobileHomeScreenProps = {
  labelSummary: LabelSummary[];
  overviewStats: OverviewStat[];
};

export function MobileHomeScreen({ labelSummary, overviewStats }: MobileHomeScreenProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b p-4">
        <span className="text-base font-semibold">Issue Deck</span>
      </header>

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
  );
}
