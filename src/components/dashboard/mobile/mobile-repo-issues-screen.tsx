"use client";

import { useMemo, useState } from "react";
import { CircleAlert, FolderGit2, Rocket } from "lucide-react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import { useReleaseStatus } from "@/hooks/use-release-status";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { summarizeReleaseButtonStatus } from "@/lib/github/release-button-status";
import {
  applyIssueFilters,
  computeLabelSummary,
  countCheckUserIssues,
  filterIssuesByView,
  getAssigneeOptions,
  sortIssues,
} from "@/lib/issue-stats";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { DeployCheckStatus, Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/**
 * ヘッダーの常時ポーリングによるGitHub API消費を抑えるため、シート開閉に連動する
 * デフォルト間隔（30秒）より長い60秒に緩和する（#542）。
 */
const HEADER_IDLE_POLL_INTERVAL_MS = 60_000;

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
  onSetIssueDeployCheck: (issue: Issue, status: DeployCheckStatus | null) => void;
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
  onSetIssueDeployCheck,
}: MobileRepoIssuesScreenProps) {
  const [releaseSheetOpen, setReleaseSheetOpen] = useState(false);
  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(repository.fullName, true, HEADER_IDLE_POLL_INTERVAL_MS);
  const releaseButtonStatus =
    releaseStatus?.available ? summarizeReleaseButtonStatus(releaseStatus) : "idle";

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
    return sortIssues(filtered, sort, view);
  }, [repoIssues, view, currentUserLogin, state, labels, assignee, sort]);

  const labelSummary = useMemo(() => computeLabelSummary(repoIssues), [repoIssues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(repoIssues), [repoIssues]);
  const checkUserCount = useMemo(() => countCheckUserIssues(repoIssues), [repoIssues]);
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
          className={cn(
            "relative flex size-11 items-center justify-center rounded-md border",
            releaseButtonStatus === "progressing" && "border-primary text-primary",
            releaseButtonStatus === "action_required" &&
              "border-amber-500 text-amber-600 dark:text-amber-500",
            releaseButtonStatus === "error" && "border-red-500 text-red-600 dark:text-red-500",
          )}
          title="リリース"
          aria-label="リリース"
        >
          {releaseButtonStatus === "progressing" && (
            <svg
              aria-hidden="true"
              className="absolute block animate-[border-trace_1.4s_linear_infinite] text-primary"
              style={{ inset: -3 }}
              viewBox="0 0 100 100"
            >
              <rect
                x="2"
                y="2"
                width="96"
                height="96"
                rx="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray="20 80"
              />
            </svg>
          )}
          {releaseButtonStatus === "action_required" && (
            <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-amber-500 text-white">
              <CircleAlert className="size-2.5" />
            </span>
          )}
          <Rocket className="size-4" />
        </button>
      }
      issues={displayedIssues}
      checkUserCount={checkUserCount}
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
        releaseStatus={releaseStatus}
        releaseStatusLoading={releaseStatusLoading}
        releaseStatusError={releaseStatusError}
        triggerRelease={triggerRelease}
        isTriggeringRelease={isTriggeringRelease}
        onSetIssueDeployCheck={onSetIssueDeployCheck}
      />
    </MobileIssueListScreen>
  );
}
