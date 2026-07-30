"use client";

import { CheckCircle2, FolderGit2, ListChecks, Plus, SlidersHorizontal, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { mockLabelSummary, mockRepositories, navCounts, navViews } from "@/lib/mock-data";
import type { MockRepository, NavViewId } from "@/types/issue";
import { cn } from "@/lib/utils";

type SidebarNavProps = {
  activeView: NavViewId;
  onSelectView: (view: NavViewId) => void;
  onSelectRepository?: (repository: MockRepository) => void;
  className?: string;
};

const viewIcons: Record<NavViewId, LucideIcon> = {
  all: ListChecks,
  assigned: CheckCircle2,
  created: FolderGit2,
  favorites: Star,
  recent: SlidersHorizontal,
};

export function SidebarNav({
  activeView,
  onSelectView,
  onSelectRepository,
  className,
}: SidebarNavProps) {
  return (
    <nav className={cn("flex flex-col gap-6 overflow-y-auto p-4", className)}>
      <div>
        <h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">全体</h2>
        <ul className="flex flex-col gap-0.5">
          {navViews.map((view) => {
            const Icon = viewIcons[view.id];
            return (
              <li key={view.id}>
                <button
                  type="button"
                  onClick={() => onSelectView(view.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    activeView === view.id && "bg-accent font-medium",
                  )}
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

      <div>
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">リポジトリ</h2>
          <button type="button" className="text-muted-foreground hover:text-foreground">
            <Plus className="size-3.5" />
          </button>
        </div>
        <ul className="flex flex-col gap-0.5">
          {mockRepositories.map((repo) => (
            <li key={repo.id}>
              <button
                type="button"
                onClick={() => onSelectRepository?.(repo)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="flex items-center gap-2 truncate">
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded"
                    style={{ backgroundColor: `${repo.color}20`, color: repo.color }}
                  >
                    <FolderGit2 className="size-3" />
                  </span>
                  <span className="truncate">{repo.name}</span>
                </span>
                <span className="text-xs text-muted-foreground">{repo.openIssueCount}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-1 px-2 text-xs text-primary hover:underline">
          すべてのリポジトリを見る
        </button>
      </div>

      <div>
        <h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">ラベル</h2>
        <ul className="flex flex-col gap-0.5">
          {mockLabelSummary.map((label) => (
            <li key={label.name}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </span>
                <span className="text-xs text-muted-foreground">{label.count}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="mt-1 px-2 text-xs text-primary hover:underline">
          すべてのラベルを見る
        </button>
      </div>

      <div className="mt-auto rounded-lg border border-dashed p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          クイックフィルターを作成
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          よく使う検索条件を保存できます
        </p>
      </div>
    </nav>
  );
}
