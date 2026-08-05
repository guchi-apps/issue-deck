"use client";

import { useMemo, useState } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { applyIssueFilters, filterIssuesByView, sortIssues } from "@/lib/issue-stats";
import { navViews } from "@/lib/nav-views";
import { cn } from "@/lib/utils";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";

const QUICK_VIEWS: NavViewId[] = ["all", "assigned", "created", "favorites", "recent"];

type MobileIssuesScreenProps = {
  issues: Issue[];
  currentUserLogin: string | null;
  labelSummary: LabelSummary[];
  assigneeOptions: string[];
  selectedIssueId: string | null;
  view: NavViewId;
  labels: string[];
  state: IssueStateFilter;
  assignee: string | null;
  sort: IssueSort;
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
};

export function MobileIssuesScreen({
  issues,
  currentUserLogin,
  labelSummary,
  assigneeOptions,
  selectedIssueId,
  view,
  labels,
  state,
  assignee,
  sort,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onCreateIssue,
}: MobileIssuesScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const displayedIssues = useMemo(() => {
    const scoped = filterIssuesByView(issues, view, currentUserLogin);
    const filtered = applyIssueFilters(scoped, {
      q: "",
      repo: null,
      state,
      labels,
      assignee,
    });
    return sortIssues(filtered, sort);
  }, [issues, view, currentUserLogin, state, labels, assignee, sort]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b p-4">
        <h1 className="text-base font-semibold">Issue</h1>
        <button
          type="button"
          onClick={() => setFilterSheetOpen(true)}
          className="flex size-11 items-center justify-center rounded-md border"
          aria-label="絞り込み・並び替え"
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </header>

      <div className="flex items-center gap-2 overflow-x-auto border-b p-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {QUICK_VIEWS.map((viewId) => {
          const label = navViews.find((v) => v.id === viewId)?.label ?? viewId;
          return (
            <button
              key={viewId}
              type="button"
              onClick={() => onChangeView(viewId)}
              className={cn(
                "flex h-11 shrink-0 items-center rounded-full border px-4 text-sm whitespace-nowrap",
                view === viewId && "border-primary bg-primary/10 text-primary",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <IssueList
        title={navViews.find((v) => v.id === view)?.label ?? ""}
        issues={displayedIssues}
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
        filters={{ state, labels, assignee, sort }}
        onChange={onChangeFilters}
        labelOptions={labelSummary}
        assigneeOptions={assigneeOptions}
      />

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
