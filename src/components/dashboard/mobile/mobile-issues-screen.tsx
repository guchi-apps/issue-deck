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
import { getNavViewLabel, navViews } from "@/lib/nav-views";
import { cn } from "@/lib/utils";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";

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
          className="rounded-md border p-2.5"
          aria-label="絞り込み・並び替え"
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </header>

      <div className="flex items-center gap-2 overflow-x-auto border-b p-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {navViews.map((navView) => (
          <button
            key={navView.id}
            type="button"
            onClick={() => onChangeView(navView.id)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap",
              view === navView.id && "border-primary bg-primary/10 text-primary",
            )}
          >
            {navView.label}
          </button>
        ))}
      </div>

      <IssueList
        title={getNavViewLabel(view)}
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
        showLabelPresets={false}
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
