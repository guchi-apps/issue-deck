"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, FolderGit2, Plus, Rocket, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import {
  MobileIssueFilterSheet,
  type MobileIssueLocalFilters,
} from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { applyIssueFilters, computeLabelSummary, getAssigneeOptions, sortIssues } from "@/lib/issue-stats";
import { getRepoColor } from "@/lib/repo-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileRepoIssuesScreenProps = {
  repository: ConnectedRepository;
  issues: Issue[];
  selectedIssueId: string | null;
  labels: string[];
  state: IssueStateFilter;
  assignee: string | null;
  sort: IssueSort;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onBack: () => void;
  onCreateIssue: () => void;
};

export function MobileRepoIssuesScreen({
  repository,
  issues,
  selectedIssueId,
  labels,
  state,
  assignee,
  sort,
  onChangeFilters,
  onSelectIssue,
  onBack,
  onCreateIssue,
}: MobileRepoIssuesScreenProps) {
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [releaseSheetOpen, setReleaseSheetOpen] = useState(false);

  const repoIssues = useMemo(
    () => issues.filter((issue) => issue.repositoryFullName === repository.fullName),
    [issues, repository.fullName],
  );

  const displayedIssues = useMemo(() => {
    const filtered = applyIssueFilters(repoIssues, {
      q: "",
      repo: null,
      state,
      labels,
      assignee,
    });
    return sortIssues(filtered, sort);
  }, [repoIssues, state, labels, assignee, sort]);

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
          <button
            type="button"
            onClick={() => setReleaseSheetOpen(true)}
            className="rounded-md border p-2.5"
            title="リリース"
            aria-label="リリース"
          >
            <Rocket className="size-4" />
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

      <MobileReleaseSheet open={releaseSheetOpen} onOpenChange={setReleaseSheetOpen} repository={repository} />

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
