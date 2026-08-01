"use client";

import { useMemo, useState } from "react";

import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import { EditIssueDialog } from "@/components/dashboard/edit-issue-dialog";
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
import { QuickFilterDialog } from "@/components/dashboard/quick-filter-dialog";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar } from "@/components/dashboard/topbar";
import { useIssueFilters } from "@/hooks/use-issue-filters";
import { useIssuePolling } from "@/hooks/use-issue-polling";
import { useMobileScreen } from "@/hooks/use-mobile-screen";
import {
  applyIssueFilters,
  computeLabelSummary,
  computeNavCounts,
  computeOverviewStats,
  filterIssuesByView,
  getAssigneeOptions,
  reconcileIssues,
  sortIssues,
} from "@/lib/issue-stats";
import { navViews } from "@/lib/nav-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { QuickFilter } from "@/types/quick-filter";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type IssueDeckShellProps = {
  currentUser: CurrentUser | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  quickFilters: QuickFilter[];
};

export function IssueDeckShell({
  currentUser,
  repositories: initialRepositories,
  issues: initialIssues,
  quickFilters: initialQuickFilters,
}: IssueDeckShellProps) {
  const { filters, setFilter, setFilters, toggleLabel } = useIssueFilters();
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [repositories, setRepositories] = useState<ConnectedRepository[]>(initialRepositories);
  const [quickFilters, setQuickFilters] = useState<QuickFilter[]>(initialQuickFilters);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [quickFilterDialogOpen, setQuickFilterDialogOpen] = useState(false);
  const { mobileScreen, selectTab, selectRepository, selectIssue, selectQuickView, goBack } =
    useMobileScreen(issues, repositories);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogRepo, setCreateDialogRepo] = useState<string | null>(null);
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null);

  const currentUserLogin = currentUser?.login ?? null;

  function openCreateDialog(defaultRepositoryFullName?: string | null) {
    setCreateDialogRepo(defaultRepositoryFullName ?? null);
    setCreateDialogOpen(true);
  }

  function handleIssueCreated(issue: Issue) {
    setIssues((prev) => [issue, ...prev]);
    setSelectedIssue(issue);
  }

  function handleIssueUpdated(issue: Issue) {
    setIssues((prev) => prev.map((item) => (item.id === issue.id ? issue : item)));
    setSelectedIssue((prev) => (prev && prev.id === issue.id ? issue : prev));
  }

  useIssuePolling((polledIssues) => {
    const reconciledIssues = reconcileIssues(issues, polledIssues);
    setIssues(reconciledIssues);
    setSelectedIssue((prev) => {
      if (!prev) return prev;
      return reconciledIssues.find((issue) => issue.id === prev.id) ?? prev;
    });
  });

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

  async function handleSetRepositoryHidden(repository: ConnectedRepository, hidden: boolean) {
    setRepositories((prev) =>
      prev.map((repo) => (repo.id === repository.id ? { ...repo, hidden } : repo)),
    );

    try {
      const response = await fetch("/api/repositories/hidden", {
        method: hidden ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId: repository.id }),
      });
      if (!response.ok) throw new Error("failed to update hidden repository");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update hidden repository", error);
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === repository.id ? { ...repo, hidden: !hidden } : repo)),
      );
    }
  }

  async function handleSetIssueFavorite(issue: Issue, favorite: boolean) {
    function applyFavorite(target: boolean) {
      setIssues((prev) =>
        prev.map((item) => (item.id === issue.id ? { ...item, favorite: target } : item)),
      );
      setSelectedIssue((prev) =>
        prev && prev.id === issue.id ? { ...prev, favorite: target } : prev,
      );
    }

    applyFavorite(favorite);

    try {
      const response = await fetch("/api/issues/favorites", {
        method: favorite ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.id }),
      });
      if (!response.ok) throw new Error("failed to update favorite issue");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update favorite issue", error);
      applyFavorite(!favorite);
    }
  }

  function applyQuickFilter(quickFilter: QuickFilter) {
    setFilters({
      view: quickFilter.view,
      q: quickFilter.q,
      repo: quickFilter.repo,
      state: quickFilter.state,
      labels: quickFilter.labels,
      assignee: quickFilter.assignee,
      sort: quickFilter.sort,
    });
    setSelectedIssue(null);
  }

  function handleSelectQuickFilter(quickFilter: QuickFilter) {
    applyQuickFilter(quickFilter);
  }

  function handleSelectQuickFilterMobile(quickFilter: QuickFilter) {
    applyQuickFilter(quickFilter);
    selectQuickView(quickFilter.view);
  }

  async function handleDeleteQuickFilter(quickFilter: QuickFilter) {
    setQuickFilters((prev) => prev.filter((item) => item.id !== quickFilter.id));

    try {
      const response = await fetch(`/api/quick-filters/${quickFilter.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("failed to delete quick filter");
    } catch (error) {
      console.error("[issue-deck-shell] failed to delete quick filter", error);
      setQuickFilters((prev) => [...prev, quickFilter]);
    }
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
        assigneeOptions={assigneeOptions}
        onCreateIssue={() => openCreateDialog(filters.repo)}
      />

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* スマホ: 画面遷移型（4タブ + ドリルダウン） */}
        <div className="flex flex-1 flex-col overflow-hidden md:hidden">
          <div className="flex-1 overflow-hidden">
            {mobileScreen.kind === "home" && (
              <MobileHomeScreen
                labelSummary={labelSummary}
                overviewStats={overviewStats}
                navCounts={navCounts}
                onSelectQuickView={selectQuickView}
                quickFilters={quickFilters}
                onSelectQuickFilter={handleSelectQuickFilterMobile}
                onDeleteQuickFilter={handleDeleteQuickFilter}
                onSaveQuickFilter={() => setQuickFilterDialogOpen(true)}
              />
            )}

            {mobileScreen.kind === "issues" && (
              <MobileIssuesScreen
                key={mobileScreen.view}
                issues={issues}
                currentUserLogin={currentUserLogin}
                labelSummary={labelSummary}
                assigneeOptions={assigneeOptions}
                selectedIssueId={null}
                initialView={mobileScreen.view}
                onSelectIssue={selectIssue}
                onCreateIssue={() => openCreateDialog()}
              />
            )}

            {mobileScreen.kind === "repos" && (
              <MobileReposScreen
                repositories={repositories}
                onSelectRepository={selectRepository}
                onHideRepository={(repo) => handleSetRepositoryHidden(repo, true)}
                onShowRepository={(repo) => handleSetRepositoryHidden(repo, false)}
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
                onSelectIssue={selectIssue}
                onBack={goBack}
                onCreateIssue={() => openCreateDialog(mobileScreen.repository.fullName)}
              />
            )}

            {mobileScreen.kind === "issue-detail" && (
              <MobileIssueDetail
                issue={mobileScreen.issue}
                issues={issues}
                onBack={goBack}
                onEdit={setEditingIssue}
                onIssueUpdated={handleIssueUpdated}
                onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
              />
            )}
          </div>

          <MobileBottomNav active={activeBottomNavTab} onSelect={selectTab} />
        </div>

        {/* PC: 左カラム（ナビゲーション） */}
        <SidebarNav
          activeView={filters.view}
          onSelectView={handleSelectView}
          navCounts={navCounts}
          repositories={repositories}
          selectedRepoFullName={filters.repo}
          onSelectRepository={(repo) => setFilter("repo", repo.fullName)}
          onHideRepository={(repo) => handleSetRepositoryHidden(repo, true)}
          onShowRepository={(repo) => handleSetRepositoryHidden(repo, false)}
          labelSummary={labelSummary}
          selectedLabels={filters.labels}
          onSelectLabel={(label) => toggleLabel(label.name)}
          onClearLabels={() => setFilter("labels", [])}
          quickFilters={quickFilters}
          onSelectQuickFilter={handleSelectQuickFilter}
          onDeleteQuickFilter={handleDeleteQuickFilter}
          onSaveQuickFilter={() => setQuickFilterDialogOpen(true)}
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
          <IssueDetail
            issue={selectedIssue}
            issues={issues}
            onEdit={setEditingIssue}
            onIssueUpdated={handleIssueUpdated}
            onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
          />
        </div>
        {selectedIssue && (
          <div className="hidden w-72 shrink-0 border-l xl:block">
            <IssuePropertiesPanel issue={selectedIssue} onIssueUpdated={handleIssueUpdated} />
          </div>
        )}
      </div>

      <CreateIssueDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        repositories={repositories}
        defaultRepositoryFullName={createDialogRepo}
        issues={issues}
        onCreated={handleIssueCreated}
      />
      <QuickFilterDialog
        open={quickFilterDialogOpen}
        onOpenChange={setQuickFilterDialogOpen}
        filters={filters}
        onCreated={(quickFilter) => setQuickFilters((prev) => [...prev, quickFilter])}
      />
      <EditIssueDialog
        open={editingIssue !== null}
        onOpenChange={(open) => {
          if (!open) setEditingIssue(null);
        }}
        issue={editingIssue}
        issues={issues}
        onUpdated={handleIssueUpdated}
      />
    </div>
  );
}
