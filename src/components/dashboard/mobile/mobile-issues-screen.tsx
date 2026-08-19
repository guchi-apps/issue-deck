"use client";

import { useMemo } from "react";

import { MergePendingPullRequests } from "@/components/dashboard/merge-pending-pull-requests";
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
import { computeIssuePrerequisiteReadiness } from "@/lib/manual-step-attention";
import type { Issue, LabelSummary, NavViewId } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

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
  /**
   * 「ユーザーの確認待ち」の一覧の先頭に出す、ユーザーのマージを待っているPull Request
   * （#1613・#1713）。ホーム画面の「要対応」とメニューの件数が数に含めているのと同じ配列を
   * 受け取る。**数だけを渡して中身を出さないと、押して開いた一覧が空に見える。**
   */
  mergePendingPullRequests: PullRequestSummary[];
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
  onAskCrossRepoQuestion: () => void;
  onBack?: () => void;
  /** 一覧を下へ引っ張ったときのIssueの取り直し（#1893） */
  onRefresh?: () => Promise<unknown> | void;
  /** 手作業アシスタント（#1826）を開く */
  onStartManualStepGuide: () => void;
  /** 「次にやること」（#1853）を開く。未対応の環境では渡らない */
  onStartIssueOrder?: () => void;
  issueOrderAutoStart?: boolean;
  issueOrderCount?: number;
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
  mergePendingPullRequests,
  onSelectPullRequest,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onCreateIssue,
  onAskCrossRepoQuestion,
  onBack,
  onRefresh,
  onStartManualStepGuide,
  onStartIssueOrder,
  issueOrderAutoStart,
  issueOrderCount,
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

  // 手作業Issueの前提条件がそろっているか（#1763）。母集団は絞り込み前の全Issue——
  // 一覧に並ぶのは手作業Issueだけで、その中からは参照先のIssueを引けない
  const prerequisiteReadiness = useMemo(() => computeIssuePrerequisiteReadiness(issues), [issues]);

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
      onRefresh={onRefresh}
      prerequisiteReadiness={prerequisiteReadiness}
      onStartManualStepGuide={onStartManualStepGuide}
      onStartIssueOrder={onStartIssueOrder}
      issueOrderAutoStart={issueOrderAutoStart}
      issueOrderCount={issueOrderCount}
      // 確認待ちにはIssueだけでなくマージ待ちPRも並べる（#1713）。件数の合流も
      // `MobileIssueListScreen`がこれを見て行うため、件数と中身が別々にならない
      pinned={{
        view: "check-user",
        count: mergePendingPullRequests.length,
        section: (
          <MergePendingPullRequests
            pullRequests={mergePendingPullRequests}
            onSelectPullRequest={onSelectPullRequest}
          />
        ),
      }}
    />
  );
}
