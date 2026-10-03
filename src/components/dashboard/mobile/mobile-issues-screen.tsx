"use client";

import { useMemo } from "react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import { useShowReservedIssues } from "@/hooks/use-show-reserved-issues";
import { useNow } from "@/hooks/use-now";
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
import { isIssueAwaitingMerge } from "@/lib/pull-request-list";
import { getNavViewLabel, navViewIsUserActionList } from "@/lib/nav-views";
import {
  selectSnoozedIssueIds,
  type SnoozeMap,
  type SnoozeTarget,
} from "@/lib/snooze";
import { selectReservedIssueIdsToHide, type ScheduledRunQueuedMap } from "@/lib/nightly-run";
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
   * ユーザーのマージを待っているPRの対応Issueのキー（`mergePendingIssueKeys`。#3650）。
   * **スマホの確認待ちからはマージ待ちを外す**ため、これに当たるIssueを一覧・件数から除く。
   * マージ待ちのPR自体は「Pull Request」の「マージ待ち」で見る。
   */
  mergePendingIssueKeys?: ReadonlySet<string>;
  /** 計画レビューを作成中のIssueのid（#3701）。マージ待ちと同じく確認待ちの一覧・件数から除く */
  planReviewCreatingIssueIds?: ReadonlySet<string>;
  /**
   * 確認待ちのうち、まだエージェントが動いていて押せる操作が無いIssueのid（#2174）。
   * タブの件数から外し、ヘッダーの件数には内訳（`2件・実行中1件`）として出す。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  /**
   * 「いまは実施しない」として伏せた項目（#2398）。件数・一覧・通知が同じ集合を読む。
   * 渡さない場合は保留の仕組みごと出さない。
   */
  snoozes?: SnoozeMap;
  onSnooze?: (target: SnoozeTarget, until: string | null) => void;
  onUnsnooze?: (target: SnoozeTarget) => void;
  /**
   * 予約実行に積まれているIssueの引き当て表（#2866）。`IssueList`へそのまま渡す
   */
  nightlyRunQueued?: ScheduledRunQueuedMap;
  /** 一覧からの一括予約（#3284）。積めたら予約実行の件数・印を取り直す。渡した画面だけ入口を出す */
  onNightlyRunQueued?: () => void;
  /** 一括予約の結果バーの「予約実行を見る」 */
  onOpenNightlyRun?: () => void;
  /**
   * 取得済みのopenなPull Request（#2816）。`IssueList`へそのまま渡し、「developへマージ」の
   * 行に「CI実行中」「Claudeがレビュー中」といった添える字を出すために使う。
   */
  pullRequests?: PullRequestSummary[];
  onChangeView: (view: NavViewId) => void;
  onChangeFilters: (filters: MobileIssueLocalFilters) => void;
  onSelectIssue: (issue: Issue) => void;
  onBack?: () => void;
  /** 一覧を下へ引っ張ったときのIssueの取り直し（#1893） */
  onRefresh?: () => Promise<unknown> | void;
  /** 最終取得時刻（ISO8601）。`MobileIssueListScreen`へそのまま渡す（#1797） */
  fetchedAt?: string | null;
  /** 自動更新の間隔（#1797）。`MobileIssueListScreen`へそのまま渡す */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
  /** 手作業アシスタント（#1826）を開く */
  onStartManualStepGuide: () => void;
  /** コードレビュー（#698）を実行するダイアログを開く。「コードレビュー」ビューでだけ出る */
  onStartCodeReview?: (repositoryFullName: string) => void;
  /** リポジトリ別の枠（#3092）の材料。一覧へそのまま渡す */
  codeReviewIssues?: Issue[];
  codeReviewRepositoryFullNames?: string[];
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
  mergePendingIssueKeys,
  planReviewCreatingIssueIds,
  checkUserRunningIssueIds,
  snoozes,
  onSnooze,
  onUnsnooze,
  nightlyRunQueued,
  onNightlyRunQueued,
  onOpenNightlyRun,
  pullRequests,
  onChangeView,
  onChangeFilters,
  onSelectIssue,
  onBack,
  onRefresh,
  fetchedAt,
  autoRefreshIntervalMs,
  onStartManualStepGuide,
  onStartCodeReview,
  codeReviewIssues,
  codeReviewRepositoryFullNames,
}: MobileIssuesScreenProps) {
  const [groupByRepo, setGroupByRepo] = useGroupByRepo(view);
  const [showReservedIssues, setShowReservedIssues] = useShowReservedIssues();
  // 未着手では予約実行に積まれたIssueを標準で伏せる（#3822。PCと同じ集合）
  const reservedIssueIdsToHide = useMemo(
    () => selectReservedIssueIdsToHide(nightlyRunQueued, showReservedIssues),
    [nightlyRunQueued, showReservedIssues],
  );

  // 一覧と件数の両方で使う絞り込み条件。片方だけ条件が欠けると、ビュー名の隣に出る件数と
  // 実際に並ぶ件数が食い違う（#1689）。
  const listFilters = useMemo(
    () => ({ q: "", repos: [] as string[], state, labels, assignee }),
    [state, labels, assignee],
  );

  // 保留中のIssue（#2398）。件数と一覧が同じ集合を読むよう、ここで1回だけ求める
  const now = useNow();
  const snoozedIssueIds = useMemo(
    () => (snoozes ? selectSnoozedIssueIds(issues, snoozes, now) : undefined),
    [issues, snoozes, now],
  );

  // 確認待ちから外す、マージ待ちPRの対応Issue（#3650）。一覧と件数が同じ集合を読む
  // 計画レビュー作成中のIssue（#3701）も同じ扱いで外す
  const awaitingMergeIssueIds = useMemo(() => {
    const ids = new Set<string>();
    if (mergePendingIssueKeys && mergePendingIssueKeys.size > 0) {
      for (const issue of issues) {
        if (isIssueAwaitingMerge(issue, mergePendingIssueKeys)) ids.add(issue.id);
      }
    }
    planReviewCreatingIssueIds?.forEach((id) => ids.add(id));
    return ids.size > 0 ? ids : undefined;
  }, [issues, mergePendingIssueKeys, planReviewCreatingIssueIds]);

  const displayedIssues = useMemo(() => {
    const byView = filterIssuesByView(issues, view, currentUserLogin);
    const scoped =
      view === "not-started" && reservedIssueIdsToHide
        ? byView.filter((issue) => !reservedIssueIdsToHide.has(issue.id))
        : byView;
    const listed =
      view === "check-user" && awaitingMergeIssueIds
        ? scoped.filter((issue) => !awaitingMergeIssueIds.has(issue.id))
        : scoped;
    return sortIssues(applyIssueFilters(listed, listFilters), sort, view);
  }, [
    issues,
    view,
    currentUserLogin,
    listFilters,
    sort,
    awaitingMergeIssueIds,
    reservedIssueIdsToHide,
  ]);

  // タブごとの該当Issue件数（#880）。「ユーザーの確認待ち」のみだった件数バッジを
  // 全タブに広げるにあたり、サイドバー・ホーム画面（#742）と同じ数え方を使う。
  const navCounts = useMemo(() => {
    const count = (target: Issue[]) =>
      computeNavCountsForFilters(
        target,
        listFilters,
        currentUserLogin,
        issues,
        // 「ユーザーの確認待ち」からは実行中のIssueを外す（#2174。PCの左メニューと同じ数え方）
        checkUserRunningIssueIds,
        // どのビューからも保留中を外す（#2398・#2456。同上、PCと同じ数え方）
        snoozedIssueIds,
        reservedIssueIdsToHide,
      );
    const counts = count(issues);
    if (!awaitingMergeIssueIds) return counts;
    // 確認待ちだけはマージ待ちPRの対応Issueを除いて数える（#3650）
    const withoutAwaitingMerge = count(issues.filter((issue) => !awaitingMergeIssueIds.has(issue.id)));
    return { ...counts, "check-user": withoutAwaitingMerge["check-user"] };
  }, [
    issues,
    listFilters,
    currentUserLogin,
    checkUserRunningIssueIds,
    snoozedIssueIds,
    awaitingMergeIssueIds,
    reservedIssueIdsToHide,
  ]);

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
      showReservedIssues={showReservedIssues}
      onChangeShowReservedIssues={setShowReservedIssues}
      reservedIssueCount={nightlyRunQueued?.size ?? 0}
      onChangeView={onChangeView}
      onChangeFilters={onChangeFilters}
      onSelectIssue={onSelectIssue}
      onBack={onBack}
      scrollKey={scrollKey}
      onRefresh={onRefresh}
      fetchedAt={fetchedAt}
      autoRefreshIntervalMs={autoRefreshIntervalMs}
      prerequisiteReadiness={prerequisiteReadiness}
      codeReviewFindingIssues={issues}
      checkUserRunningIssueIds={checkUserRunningIssueIds}
      pullRequests={pullRequests}
      onStartManualStepGuide={onStartManualStepGuide}
      onStartCodeReview={onStartCodeReview}
      codeReviewIssues={codeReviewIssues}
      codeReviewRepositoryFullNames={codeReviewRepositoryFullNames}
      snoozes={snoozes}
      onSnooze={onSnooze}
      onUnsnooze={onUnsnooze}
      nightlyRunQueued={nightlyRunQueued}
      onNightlyRunQueued={onNightlyRunQueued}
      onOpenNightlyRun={onOpenNightlyRun}
    />
  );
}
