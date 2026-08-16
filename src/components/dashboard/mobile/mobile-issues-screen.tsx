"use client";

import { useMemo } from "react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import {
  applyIssueFilters,
  computeNavCountsForFilters,
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

  // 一覧と件数の両方で使う絞り込み条件。片方だけ条件が欠けると、ビュー名の隣に出る件数と
  // 実際に並ぶ件数が食い違う（#1689）。
  const listFilters = useMemo(
    () => ({ q: "", repos: [] as string[], state, labels, assignee }),
    [state, labels, assignee],
  );

  const displayedIssues = useMemo(() => {
    const scoped = filterIssuesByView(issues, view, currentUserLogin);
    return sortIssues(applyIssueFilters(scoped, listFilters), sort, view);
  }, [issues, view, currentUserLogin, listFilters, sort]);

  // タブごとの該当Issue件数（#880）。「ユーザーの確認待ち」のみだった件数バッジを
  // 全タブに広げるにあたり、サイドバー・ホーム画面（#742）と同じ数え方を使う。
  const navCounts = useMemo(
    () => computeNavCountsForFilters(issues, listFilters, currentUserLogin),
    [issues, listFilters, currentUserLogin],
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
