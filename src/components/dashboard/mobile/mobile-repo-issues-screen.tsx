"use client";

import { useMemo, useState } from "react";
import { FolderGit2, Rocket } from "lucide-react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import {
  applyIssueFilters,
  computeLabelSummary,
  filterIssuesByView,
  getAssigneeOptions,
  sortIssues,
} from "@/lib/issue-stats";
import { getRepoColor } from "@/lib/repo-color";
import type { Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileRepoIssuesScreenProps = {
  repository: ConnectedRepository;
  issues: Issue[];
  currentUserLogin: string | null;
  selectedIssueId: string | null;
  view: NavViewId;
  labels: string[];
  state: IssueStateFilter;
  assignee: string | null;
  sort: IssueSort;
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onBack: () => void;
  onCreateIssue: () => void;
};

export function MobileRepoIssuesScreen({
  repository,
  issues,
  currentUserLogin,
  selectedIssueId,
  view,
  labels,
  state,
  assignee,
  sort,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onBack,
  onCreateIssue,
}: MobileRepoIssuesScreenProps) {
  const [releaseSheetOpen, setReleaseSheetOpen] = useState(false);

  const repoIssues = useMemo(
    () => issues.filter((issue) => issue.repositoryFullName === repository.fullName),
    [issues, repository.fullName],
  );

  const displayedIssues = useMemo(() => {
    const scoped = filterIssuesByView(repoIssues, view, currentUserLogin);
    const filtered = applyIssueFilters(scoped, {
      q: "",
      repo: null,
      state,
      labels,
      assignee,
    });
    return sortIssues(filtered, sort);
  }, [repoIssues, view, currentUserLogin, state, labels, assignee, sort]);

  const labelSummary = useMemo(() => computeLabelSummary(repoIssues), [repoIssues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(repoIssues), [repoIssues]);
  const color = getRepoColor(repository.fullName);

  return (
    <MobileIssueListScreen
      title={repository.name}
      meta={repository.private ? "Private" : "Public"}
      icon={
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded"
          style={{ backgroundColor: `${color}20`, color }}
        >
          <FolderGit2 className="size-4" />
        </span>
      }
      onBack={onBack}
      headerActions={
        <button
          type="button"
          onClick={() => setReleaseSheetOpen(true)}
          className="flex size-11 items-center justify-center rounded-md border"
          title="リリース"
          aria-label="リリース"
        >
          <Rocket className="size-4" />
        </button>
      }
      issues={displayedIssues}
      selectedIssueId={selectedIssueId}
      view={view}
      filters={{ state, labels, assignee, sort }}
      labelOptions={labelSummary}
      assigneeOptions={assigneeOptions}
      onChangeView={onChangeView}
      onChangeFilters={onChangeFilters}
      onSelectIssue={onSelectIssue}
      onCreateIssue={onCreateIssue}
    >
      <MobileReleaseSheet
        open={releaseSheetOpen}
        onOpenChange={setReleaseSheetOpen}
        repository={repository}
        issues={issues}
      />
    </MobileIssueListScreen>
  );
}
