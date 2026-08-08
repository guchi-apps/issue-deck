"use client";

import { useMemo } from "react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import {
  applyIssueFilters,
  countCheckUserIssues,
  filterIssuesByView,
  sortIssues,
} from "@/lib/issue-stats";
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
  onAskQuestion: () => void;
  onBack?: () => void;
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
  onAskQuestion,
  onBack,
}: MobileIssuesScreenProps) {
  const [groupByRepo, setGroupByRepo] = useGroupByRepo(view);

  const displayedIssues = useMemo(() => {
    const scoped = filterIssuesByView(issues, view, currentUserLogin);
    const filtered = applyIssueFilters(scoped, {
      q: "",
      repos: [],
      state,
      labels,
      assignee,
    });
    return sortIssues(filtered, sort, view);
  }, [issues, view, currentUserLogin, state, labels, assignee, sort]);

  const checkUserCount = useMemo(() => countCheckUserIssues(issues), [issues]);

  // Issue詳細へ遷移するとこの画面はアンマウントされるため、スクロール位置は絞り込み条件
  // ごとにsessionStorageへ退避しておき、戻ってきたときに復元する（#773）。
  const scrollKey = useMemo(
    () =>
      buildIssueListScrollKey([
        "mobile-issues",
        view,
        state,
        labels.join(","),
        assignee,
        sort,
      ]),
    [view, state, labels, assignee, sort],
  );

  return (
    <MobileIssueListScreen
      title="Issue"
      issues={displayedIssues}
      checkUserCount={checkUserCount}
      selectedIssueId={selectedIssueId}
      view={view}
      filters={{ state, labels, assignee, sort }}
      labelOptions={labelSummary}
      assigneeOptions={assigneeOptions}
      groupByRepo={groupByRepo}
      onChangeGroupByRepo={setGroupByRepo}
      onChangeView={onChangeView}
      onChangeFilters={onChangeFilters}
      onSelectIssue={onSelectIssue}
      onCreateIssue={onCreateIssue}
      onAskQuestion={onAskQuestion}
      onBack={onBack}
      scrollKey={scrollKey}
    />
  );
}
