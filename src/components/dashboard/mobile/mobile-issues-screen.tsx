"use client";

import { useMemo } from "react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import {
  applyIssueFilters,
  computeNavCounts,
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
  onAskCrossRepoQuestion: () => void;
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
  onAskCrossRepoQuestion,
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

  // タブごとの該当Issue件数（#880）。「ユーザーの確認待ち」のみだった件数バッジを
  // 全タブに広げるにあたり、サイドバー・ホーム画面（#742）と同じcomputeNavCountsを使う。
  const navCounts = useMemo(
    () => computeNavCounts(issues, issues, currentUserLogin),
    [issues, currentUserLogin],
  );

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
      navCounts={navCounts}
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
      onAskCrossRepoQuestion={onAskCrossRepoQuestion}
      onBack={onBack}
      scrollKey={scrollKey}
    />
  );
}
