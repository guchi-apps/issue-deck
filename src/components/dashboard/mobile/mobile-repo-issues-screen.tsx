"use client";

import { useMemo, useState } from "react";
import { CircleAlert, FolderGit2, Rocket } from "lucide-react";

import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import { MobileReleaseSheet } from "@/components/dashboard/mobile/mobile-release-sheet";
import { useReleaseStatus } from "@/hooks/use-release-status";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { summarizeReleaseButtonStatus } from "@/lib/github/release-button-status";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import {
  applyIssueFilters,
  computeLabelSummary,
  computeNavCountsForFilters,
  filterIssuesByView,
  getAssigneeOptions,
  sortIssues,
} from "@/lib/issue-stats";
import { computeIssuePrerequisiteReadiness } from "@/lib/manual-step-attention";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { Issue, NavViewId } from "@/types/issue";
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
  onAskCrossRepoQuestion: () => void;
  /** 一覧を下へ引っ張ったときのIssueの取り直し（#1893） */
  onRefresh?: () => Promise<unknown> | void;
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
  onAskCrossRepoQuestion,
  onRefresh,
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

  // 一覧と件数の両方で使う絞り込み条件。片方だけ条件が欠けると、ビュー名の隣に出る件数と
  // 実際に並ぶ件数が食い違う（#1689）。
  const listFilters = useMemo(
    () => ({ q: "", repos: [] as string[], state, labels, assignee }),
    [state, labels, assignee],
  );

  const displayedIssues = useMemo(() => {
    const scoped = filterIssuesByView(repoIssues, view, currentUserLogin);
    return sortIssues(applyIssueFilters(scoped, listFilters), sort, view);
  }, [repoIssues, view, currentUserLogin, listFilters, sort]);

  const labelSummary = useMemo(() => computeLabelSummary(repoIssues), [repoIssues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(repoIssues), [repoIssues]);
  // タブごとの該当Issue件数（#880）。全タブに件数バッジを表示するため、リポジトリで
  // 絞り込んだissuesを母集団に、一覧と同じ絞り込みを適用して求める（#1689）。
  // 母集団に絞り込み前の全Issueを渡すのは、手作業Issueが別リポジトリのIssue・PRを
  // 待っていることがあるため（#1763）。このリポジトリ分だけでは「状態不明＝実行できる」に倒れる
  const navCounts = useMemo(
    () => computeNavCountsForFilters(repoIssues, listFilters, currentUserLogin, issues),
    [repoIssues, listFilters, currentUserLogin, issues],
  );

  // 手作業Issueの前提条件がそろっているか（#1763）。判定の母集団も全Issue
  const prerequisiteReadiness = useMemo(() => computeIssuePrerequisiteReadiness(issues), [issues]);
  const color = getRepoColor(repository.fullName);

  // Issue詳細へ遷移するとこの画面はアンマウントされるため、スクロール位置はリポジトリ・
  // 絞り込み条件ごとにsessionStorageへ退避しておき、戻ってきたときに復元する（#773）。
  const scrollKey = useMemo(
    () =>
      buildIssueListScrollKey([
        "mobile-repo",
        repository.fullName,
        view,
        state,
        labels.join(","),
        assignee,
        sort,
      ]),
    [repository.fullName, view, state, labels, assignee, sort],
  );

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
            releaseButtonStatus === "progressing" && "border-sky-500 text-sky-600 dark:text-sky-500",
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
              className="absolute inset-0 block size-full animate-[border-trace_1.4s_linear_infinite]"
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
      navCounts={navCounts}
      prerequisiteReadiness={prerequisiteReadiness}
      selectedIssueId={selectedIssueId}
      view={view}
      filters={{ state, labels, assignee, sort }}
      labelOptions={labelSummary}
      assigneeOptions={assigneeOptions}
      onChangeView={onChangeView}
      onChangeFilters={onChangeFilters}
      onSelectIssue={onSelectIssue}
      onCreateIssue={onCreateIssue}
      onAskCrossRepoQuestion={onAskCrossRepoQuestion}
      scrollKey={scrollKey}
      onRefresh={onRefresh}
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
      />
    </MobileIssueListScreen>
  );
}
