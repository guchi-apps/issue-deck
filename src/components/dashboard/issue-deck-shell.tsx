"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";

import { IssueDetail } from "@/components/dashboard/issue-detail";
import { IssueList } from "@/components/dashboard/issue-list";
import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import {
  MobileBottomNav,
  type MobileBottomNavTab,
} from "@/components/dashboard/mobile-bottom-nav";
import { MobileHomeScreen } from "@/components/dashboard/mobile/mobile-home-screen";
import { MobileIssueDetail } from "@/components/dashboard/mobile/mobile-issue-detail";
import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import { MobileRepoIssuesScreen } from "@/components/dashboard/mobile/mobile-repo-issues-screen";
import { MobileReposScreen } from "@/components/dashboard/mobile/mobile-repos-screen";
import { MobileSettingsScreen } from "@/components/dashboard/mobile/mobile-settings-screen";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar } from "@/components/dashboard/topbar";
import { useIssueFilters } from "@/hooks/use-issue-filters";
import type { FetchIssuesError } from "@/lib/github/fetch-dashboard-issues";
import {
  applyIssueFilters,
  computeLabelSummary,
  computeNavCounts,
  computeOverviewStats,
  filterIssuesByView,
  getAssigneeOptions,
  sortIssues,
} from "@/lib/issue-stats";
import { navViews } from "@/lib/nav-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type MobileScreen =
  | { kind: "home" }
  | { kind: "issues" }
  | { kind: "repos" }
  | { kind: "settings" }
  | { kind: "repo-detail"; repository: ConnectedRepository; back: MobileScreen }
  | { kind: "issue-detail"; issue: Issue; back: MobileScreen };

type IssueDeckShellProps = {
  currentUser: CurrentUser | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  fetchErrors: FetchIssuesError[];
};

export function IssueDeckShell({
  currentUser,
  repositories,
  issues,
  fetchErrors,
}: IssueDeckShellProps) {
  const { filters, setFilter, toggleLabel } = useIssueFilters();
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>({ kind: "home" });
  const [errorBannerDismissed, setErrorBannerDismissed] = useState(false);

  const currentUserLogin = currentUser?.login ?? null;

  // TopBarの絞り込み（キーワード・リポジトリ・状態・ラベル・担当者）を適用した集合。
  // サイドバーの件数表示はこれを基準にする。
  const topbarFilteredIssues = useMemo(
    () => applyIssueFilters(issues, filters),
    [issues, filters],
  );

  const filteredIssues = useMemo(
    () =>
      sortIssues(
        filterIssuesByView(topbarFilteredIssues, filters.view, currentUserLogin),
        filters.sort,
      ),
    [topbarFilteredIssues, filters.view, filters.sort, currentUserLogin],
  );

  const navCounts = useMemo(
    () => computeNavCounts(topbarFilteredIssues, currentUserLogin),
    [topbarFilteredIssues, currentUserLogin],
  );
  const overviewStats = useMemo(
    () => computeOverviewStats(topbarFilteredIssues, currentUserLogin),
    [topbarFilteredIssues, currentUserLogin],
  );
  const labelSummary = useMemo(() => computeLabelSummary(issues), [issues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(issues), [issues]);

  function handleSelectView(view: NavViewId) {
    setFilter("view", view);
    setSelectedIssue(null);
  }

  function handleMobileSelectRepository(repository: ConnectedRepository) {
    setMobileScreen((prev) => ({ kind: "repo-detail", repository, back: prev }));
  }

  function handleMobileSelectIssue(issue: Issue) {
    setMobileScreen((prev) => ({ kind: "issue-detail", issue, back: prev }));
  }

  function handleMobileBack() {
    setMobileScreen((prev) =>
      prev.kind === "issue-detail" || prev.kind === "repo-detail" ? prev.back : { kind: "home" },
    );
  }

  function handleBottomNavSelect(tab: MobileBottomNavTab) {
    setMobileScreen({ kind: tab });
  }

  const activeBottomNavTab: MobileBottomNavTab =
    mobileScreen.kind === "issue-detail" || mobileScreen.kind === "repo-detail"
      ? "home"
      : mobileScreen.kind;

  return (
    <div className="flex h-dvh flex-col">
      <TopBar
        currentUser={currentUser}
        filters={filters}
        setFilter={setFilter}
        toggleLabel={toggleLabel}
        repositories={repositories}
        labelSummary={labelSummary}
        assigneeOptions={assigneeOptions}
      />

      {fetchErrors.length > 0 && !errorBannerDismissed && (
        <div className="flex items-center justify-between gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <span>
            {fetchErrors.length}件のリポジトリでIssue取得に失敗しました（
            {fetchErrors.map((e) => e.repo).join(", ")}）
          </span>
          <button type="button" onClick={() => setErrorBannerDismissed(true)}>
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* スマホ: 画面遷移型（4タブ + ドリルダウン） */}
        <div className="flex flex-1 flex-col overflow-hidden md:hidden">
          <div className="flex-1 overflow-hidden">
            {mobileScreen.kind === "home" && (
              <MobileHomeScreen labelSummary={labelSummary} overviewStats={overviewStats} />
            )}

            {mobileScreen.kind === "issues" && (
              <MobileIssuesScreen
                issues={issues}
                currentUserLogin={currentUserLogin}
                labelSummary={labelSummary}
                assigneeOptions={assigneeOptions}
                selectedIssueId={null}
                onSelectIssue={handleMobileSelectIssue}
              />
            )}

            {mobileScreen.kind === "repos" && (
              <MobileReposScreen
                repositories={repositories}
                onSelectRepository={handleMobileSelectRepository}
              />
            )}

            {mobileScreen.kind === "settings" && (
              <MobileSettingsScreen currentUser={currentUser} />
            )}

            {mobileScreen.kind === "repo-detail" && (
              <MobileRepoIssuesScreen
                repository={mobileScreen.repository}
                issues={issues}
                selectedIssueId={null}
                onSelectIssue={handleMobileSelectIssue}
                onBack={handleMobileBack}
              />
            )}

            {mobileScreen.kind === "issue-detail" && (
              <MobileIssueDetail issue={mobileScreen.issue} onBack={handleMobileBack} />
            )}
          </div>

          <MobileBottomNav active={activeBottomNavTab} onSelect={handleBottomNavSelect} />
        </div>

        {/* PC: 左カラム（ナビゲーション） */}
        <SidebarNav
          activeView={filters.view}
          onSelectView={handleSelectView}
          navCounts={navCounts}
          repositories={repositories}
          onSelectRepository={(repo) => setFilter("repo", repo.fullName)}
          labelSummary={labelSummary}
          className="hidden w-60 shrink-0 border-r md:flex"
        />

        {/* PC: 中央カラム（Issue一覧） */}
        <IssueList
          title={navViews.find((view) => view.id === filters.view)?.label ?? ""}
          issues={filteredIssues}
          selectedIssueId={selectedIssue?.id ?? null}
          onSelectIssue={setSelectedIssue}
          showSearch={false}
          className="hidden w-96 shrink-0 border-r md:flex"
        />

        {/* PC: 右カラム（Issue詳細 + プロパティパネル） */}
        <div className="hidden flex-1 overflow-hidden md:flex">
          <IssueDetail issue={selectedIssue} />
        </div>
        {selectedIssue && (
          <div className="hidden w-72 shrink-0 border-l xl:block">
            <IssuePropertiesPanel issue={selectedIssue} />
          </div>
        )}
      </div>
    </div>
  );
}
