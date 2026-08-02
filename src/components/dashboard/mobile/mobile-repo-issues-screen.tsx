"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, FolderGit2, MoreHorizontal, Plus, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { applyIssueFilters, computeLabelSummary, getAssigneeOptions, sortIssues } from "@/lib/issue-stats";
import { getRepoColor } from "@/lib/repo-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileRepoIssuesScreenProps = {
  repository: ConnectedRepository;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  onBack: () => void;
  onCreateIssue: () => void;
};

export function MobileRepoIssuesScreen({
  repository,
  issues,
  selectedIssueId,
  onSelectIssue,
  onBack,
  onCreateIssue,
}: MobileRepoIssuesScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<MobileIssueLocalFilters>({
    state: "open",
    labels: [],
    assignee: null,
    sort: "created",
  });

  const repoIssues = useMemo(
    () => issues.filter((issue) => issue.repositoryFullName === repository.fullName),
    [issues, repository.fullName],
  );

  const displayedIssues = useMemo(() => {
    const filtered = applyIssueFilters(repoIssues, {
      q: "",
      repo: null,
      state: localFilters.state,
      labels: localFilters.labels,
      assignee: localFilters.assignee,
    });
    return sortIssues(filtered, localFilters.sort);
  }, [repoIssues, localFilters]);

  const labelSummary = useMemo(() => computeLabelSummary(repoIssues), [repoIssues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(repoIssues), [repoIssues]);
  const color = getRepoColor(repository.fullName);
  const swipeBackHandlers = useSwipeBack(onBack);

  return (
    <div className="relative flex h-full flex-col overflow-hidden" {...swipeBackHandlers}>
      <header className="flex items-center gap-1 border-b p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="-m-2 rounded-full p-2 active:bg-muted"
        >
          <ArrowLeft className="size-5" />
        </button>
        <span className="text-sm text-muted-foreground">リポジトリ</span>
      </header>

      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <span
            className="flex size-9 items-center justify-center rounded"
            style={{ backgroundColor: `${color}20`, color }}
          >
            <FolderGit2 className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">{repository.name}</h1>
            <p className="text-xs text-muted-foreground">
              {repository.private ? "Private" : "Public"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterSheetOpen(true)}
            className="rounded-md border p-2.5"
            aria-label="絞り込み・並び替え"
          >
            <SlidersHorizontal className="size-4" />
          </button>
          <button type="button" aria-label="その他の操作" className="rounded-md border p-2.5">
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </div>

      <IssueList
        title={repository.name}
        issues={displayedIssues}
        selectedIssueId={selectedIssueId}
        onSelectIssue={onSelectIssue}
        showSearch={false}
        showHeader={false}
        className="flex-1"
      />

      <MobileIssueFilterSheet
        open={filterSheetOpen}
        onOpenChange={setFilterSheetOpen}
        filters={localFilters}
        onChange={setLocalFilters}
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
