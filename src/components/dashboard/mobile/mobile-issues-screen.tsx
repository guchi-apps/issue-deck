"use client";

import { useCallback, useMemo } from "react";

import { MergePendingPullRequests } from "@/components/dashboard/merge-pending-pull-requests";
import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import type { AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import {
  applyIssueFilters,
  computeNavCountsForFilters,
  filterIssuesByView,
  sortIssues,
} from "@/lib/issue-stats";
import { computeIssuePrerequisiteReadiness } from "@/lib/manual-step-attention";
import { getNavViewLabel, navViewIsUserActionList } from "@/lib/nav-views";
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
  /**
   * CI・判定の完了待ちで上の配列から外したPRの件数（#2081）。件数表示には足さず、
   * 枠の下の1行にだけ出す。
   */
  mergeCheckWaitingCount?: number;
  /**
   * 確認待ちのうち、まだエージェントが動いていて押せる操作が無いIssueのid（#2174）。
   * タブの件数から外し、ヘッダーの件数には内訳（`2件・実行中1件`）として出す。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
  onAskCrossRepoQuestion: () => void;
  onBack?: () => void;
  /** 一覧を下へ引っ張ったときのIssueの取り直し（#1893） */
  onRefresh?: () => Promise<unknown> | void;
  /**
   * 同じ操作で走らせるPull Requestの取り直し（#2175）。**呼ぶのは「ユーザーの確認待ち」を
   * 見ているときだけ。** この一覧の先頭にはマージ待ちPRが並ぶのに、確認待ちのビューでは
   * PRの自動更新を止めている（`usePullRequests`に間隔を渡すのはPR画面とブランチ画面だけ）
   * ため、Issueだけ取り直すと画面の上半分は開いた時点のまま残る。他のビューで呼ばないのは、
   * 1回の取得でリポジトリ数ぶんのGitHub APIを使うため。
   */
  onRefreshPullRequests?: () => Promise<unknown> | void;
  /** 最終取得時刻（ISO8601）。`MobileIssueListScreen`へそのまま渡す（#1797） */
  fetchedAt?: string | null;
  /** 自動更新の間隔（#1797）。`MobileIssueListScreen`へそのまま渡す */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
  /** 手作業アシスタント（#1826）を開く */
  onStartManualStepGuide: () => void;
  /** 「次にやること」（#1853）を開く。未対応の環境では渡らない */
  onStartIssueOrder?: () => void;
  /** コードレビュー（#698）を実行するダイアログを開く。「コードレビュー」ビューでだけ出る */
  onStartCodeReview?: () => void;
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
  mergeCheckWaitingCount = 0,
  checkUserRunningIssueIds,
  onSelectPullRequest,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onCreateIssue,
  onAskCrossRepoQuestion,
  onBack,
  onRefresh,
  onRefreshPullRequests,
  fetchedAt,
  autoRefreshIntervalMs,
  onStartManualStepGuide,
  onStartIssueOrder,
  onStartCodeReview,
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
    () =>
      computeNavCountsForFilters(
        issues,
        listFilters,
        currentUserLogin,
        issues,
        // 「ユーザーの確認待ち」からは実行中のIssueを外す（#2174。PCの左メニューと同じ数え方）
        checkUserRunningIssueIds,
      ),
    [issues, listFilters, currentUserLogin, checkUserRunningIssueIds],
  );

  // 手作業Issueの前提条件がそろっているか（#1763）。母集団は絞り込み前の全Issue——
  // 一覧に並ぶのは手作業Issueだけで、その中からは参照先のIssueを引けない
  const prerequisiteReadiness = useMemo(() => computeIssuePrerequisiteReadiness(issues), [issues]);

  // 一覧を下へ引っ張ったときの取り直し（#1893）。**確認待ちのときだけPull Requestも
  // 一緒に取り直し、両方が返るまで待つ**（#2175）。待たずに返すと「更新中…」が最短表示の
  // 0.5秒（`MIN_REFRESHING_MS`）で消え、数秒かかるGitHubからの取得が終わったように見える。
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      onRefresh?.(),
      view === "check-user" ? onRefreshPullRequests?.() : undefined,
    ]);
  }, [onRefresh, onRefreshPullRequests, view]);

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
      // 「ユーザーの確認待ち」「ユーザーの作業待ち」はIssueだけの一覧ではないため、
      // 見出しを「Issue」からビュー名へ差し替える（#2081。判定は`navViewIsUserActionList`）。
      // 確認待ちにはユーザーのマージを待っているPull Requestが混ざり、作業待ちに並ぶのは
      // 開発のIssueではなく人が実行する手順。差し替えたぶん、下の行からはビュー名が落ちる
      // （`MobileIssueListScreen`が見出しと同じ言葉を重ねない）。
      title={navViewIsUserActionList(view) ? getNavViewLabel(view) : "Issue"}
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
      onRefresh={onRefresh ? handleRefresh : undefined}
      fetchedAt={fetchedAt}
      autoRefreshIntervalMs={autoRefreshIntervalMs}
      prerequisiteReadiness={prerequisiteReadiness}
      checkUserRunningIssueIds={checkUserRunningIssueIds}
      onStartManualStepGuide={onStartManualStepGuide}
      onStartIssueOrder={onStartIssueOrder}
      onStartCodeReview={onStartCodeReview}
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
            waitingForChecksCount={mergeCheckWaitingCount}
            onSelectPullRequest={onSelectPullRequest}
          />
        ),
      }}
    />
  );
}
