"use client";

import { useEffect, useMemo, useState } from "react";

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
import { MobileScreenSkeleton } from "@/components/dashboard/mobile/mobile-screen-skeleton";
import { MobileSettingsScreen } from "@/components/dashboard/mobile/mobile-settings-screen";
import { QuickFilterDialog } from "@/components/dashboard/quick-filter-dialog";
import { RepositorySettingsDialog } from "@/components/dashboard/repository-settings-dialog";
import { ResizeHandle } from "@/components/dashboard/resize-handle";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar } from "@/components/dashboard/topbar";
import { useIssueFilters } from "@/hooks/use-issue-filters";
import { useIssuePolling } from "@/hooks/use-issue-polling";
import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useResizableWidth } from "@/hooks/use-resizable-width";
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
import { resolveBottomNavTab } from "@/lib/mobile-nav-tab";
import { getNavViewLabel } from "@/lib/nav-views";
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
  const { filters, setFilter, setFilters, selectView, toggleLabel } = useIssueFilters();
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [repositories, setRepositories] = useState<ConnectedRepository[]>(initialRepositories);
  const [quickFilters, setQuickFilters] = useState<QuickFilter[]>(initialQuickFilters);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [quickFilterDialogOpen, setQuickFilterDialogOpen] = useState(false);
  const [repositorySettingsTarget, setRepositorySettingsTarget] =
    useState<ConnectedRepository | null>(null);
  const {
    mobileScreen,
    isPending: isMobileScreenPending,
    selectTab,
    selectRepository,
    selectIssue,
    selectQuickView,
    applyQuickFilter: applyMobileQuickFilter,
    updateListFilters,
    goBack,
  } = useMobileScreen(issues, repositories);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogRepo, setCreateDialogRepo] = useState<string | null>(null);
  const [createDialogBody, setCreateDialogBody] = useState<string | null>(null);
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null);

  // PC向け4カラムレイアウトの表示調整（#381）。左メニューは手動で開閉でき、
  // サイドバー・Issue一覧・プロパティパネルの3カラムはドラッグで幅を調整できる。
  // いずれもlocalStorageに永続化し、次回アクセス時に復元する。
  const [isSidebarCollapsed, setIsSidebarCollapsed] = usePersistedState(
    "issue-deck:sidebar-collapsed",
    false,
  );
  const sidebarWidth = useResizableWidth({
    storageKey: "issue-deck:sidebar-width",
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    handleSide: "right",
  });
  const issueListWidth = useResizableWidth({
    storageKey: "issue-deck:issue-list-width",
    defaultWidth: 384,
    minWidth: 280,
    maxWidth: 600,
    handleSide: "right",
  });
  const propertiesPanelWidth = useResizableWidth({
    storageKey: "issue-deck:properties-panel-width",
    defaultWidth: 288,
    minWidth: 220,
    maxWidth: 480,
    handleSide: "left",
  });

  const currentUserLogin = currentUser?.login ?? null;

  function openCreateDialog(defaultRepositoryFullName?: string | null) {
    setCreateDialogRepo(defaultRepositoryFullName ?? null);
    setCreateDialogBody(null);
    setCreateDialogOpen(true);
  }

  // 既にマージ・クローズ済みのIssueは本文を直接編集できないため、続きの対応が必要な場合は
  // 元Issue番号を本文に記入した状態で新規Issueを作成できるようにする（#169）。
  function openFollowupIssueDialog(issue: Issue) {
    setCreateDialogRepo(issue.repositoryFullName);
    setCreateDialogBody(`## Issue #${issue.number} に関連するセクションです\n\n`);
    setCreateDialogOpen(true);
  }

  function handleIssueCreated(issue: Issue) {
    // 作成直後にポーリングが先に反映済みの場合があり、単純な先頭追加だと
    // 同じIssueが重複表示される（#449）。既存分があれば更新、なければ先頭に追加する。
    setIssues((prev) =>
      prev.some((item) => item.id === issue.id)
        ? prev.map((item) => (item.id === issue.id ? issue : item))
        : [issue, ...prev],
    );
    setSelectedIssue(issue);
    // スマホはURLクエリで画面遷移を管理しているため、PC用のselectedIssueだけでは
    // 詳細画面へ遷移しない。selectIssueで両方に対応する（#192）。
    selectIssue(issue);
  }

  function handleIssueUpdated(issue: Issue) {
    setIssues((prev) => prev.map((item) => (item.id === issue.id ? issue : item)));
    setSelectedIssue((prev) => (prev && prev.id === issue.id ? issue : prev));
  }

  function handleIssueDeleted(issue: Issue) {
    setIssues((prev) => prev.filter((item) => item.id !== issue.id));
    setSelectedIssue((prev) => (prev && prev.id === issue.id ? null : prev));
  }

  // PC・スマホどちらで開いていても、現在表示中のIssueを検知して既読化する
  // （URLの`missue`クエリを直接開いた場合＝リロード・共有リンクもmobileScreen経由でカバーされる）
  const displayedIssueId =
    selectedIssue?.id ?? (mobileScreen.kind === "issue-detail" ? mobileScreen.issue.id : null);

  useEffect(() => {
    if (!displayedIssueId) return;
    const issue = issues.find((item) => item.id === displayedIssueId);
    if (!issue || !issue.hasUnreadComments) return;

    let cancelled = false;

    fetch("/api/issues/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: issue.id, readCommentCount: issue.commentCount }),
    })
      .then((response) => {
        if (!response.ok || cancelled) return;
        setIssues((prev) =>
          prev.map((item) => (item.id === issue.id ? { ...item, hasUnreadComments: false } : item)),
        );
        setSelectedIssue((prev) =>
          prev && prev.id === issue.id ? { ...prev, hasUnreadComments: false } : prev,
        );
      })
      .catch((error) => {
        console.error("[issue-deck-shell] failed to mark issue comments as read", error);
      });

    return () => {
      cancelled = true;
    };
  }, [displayedIssueId, issues]);

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

  // 「直近main反映済み」のようにclose済みIssueを含むビューの件数を数えるための、
  // 状態（open/closed）の絞り込みだけを外した集合。
  const topbarFilteredIssuesIgnoringState = useMemo(
    () => applyIssueFilters(issues, { ...filters, state: "all" }),
    [issues, filters],
  );

  const filteredIssues = useMemo(
    () =>
      sortIssues(
        // 「最新リリース」の基準時刻は絞り込み前の全Issueから求める（キーワード検索などで
        // 基準がずれて古いリリース分が現れないようにする）。
        filterIssuesByView(topbarFilteredIssues, filters.view, currentUserLogin, issues),
        filters.sort,
      ),
    [topbarFilteredIssues, issues, filters.view, filters.sort, currentUserLogin],
  );

  const navCounts = useMemo(
    () =>
      computeNavCounts(
        topbarFilteredIssues,
        topbarFilteredIssuesIgnoringState,
        currentUserLogin,
        issues,
      ),
    [topbarFilteredIssues, topbarFilteredIssuesIgnoringState, issues, currentUserLogin],
  );
  const overviewStats = useMemo(
    () => computeOverviewStats(topbarFilteredIssues, topbarFilteredIssuesIgnoringState),
    [topbarFilteredIssues, topbarFilteredIssuesIgnoringState],
  );
  const labelSummary = useMemo(() => computeLabelSummary(issues), [issues]);
  const assigneeOptions = useMemo(() => getAssigneeOptions(issues), [issues]);

  // Issue作成ダイアログのリポジトリ選択肢は、サイドメニューで非表示にしたリポジトリを
  // 除いたもの（メニューに表示中のリポジトリ一覧）に揃える（#367）。
  const visibleRepositories = useMemo(
    () => repositories.filter((repo) => !repo.hidden),
    [repositories],
  );

  function handleSelectView(view: NavViewId) {
    selectView(view);
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

  function handleRepositorySettingsUpdated(repositoryId: string, autoRetryLimit: number) {
    setRepositories((prev) =>
      prev.map((repo) => (repo.id === repositoryId ? { ...repo, autoRetryLimit } : repo)),
    );
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
    applyMobileQuickFilter(quickFilter);
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

  const activeBottomNavTab: MobileBottomNavTab = resolveBottomNavTab(mobileScreen);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar
        currentUser={currentUser}
        filters={filters}
        setFilter={setFilter}
        assigneeOptions={assigneeOptions}
        onCreateIssue={() => openCreateDialog(filters.repo)}
        selectedRepoFullName={filters.repo}
        repositories={repositories}
        issues={issues}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
      />

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* スマホ: 画面遷移型（4タブ + ドリルダウン） */}
        <div className="flex flex-1 flex-col overflow-hidden md:hidden">
          <div className="flex-1 overflow-hidden">
            {isMobileScreenPending ? (
              <MobileScreenSkeleton />
            ) : (
              <>
                {mobileScreen.kind === "home" && (
                  <MobileHomeScreen
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
                    issues={issues}
                    currentUserLogin={currentUserLogin}
                    labelSummary={labelSummary}
                    assigneeOptions={assigneeOptions}
                    selectedIssueId={mobileScreen.returnToIssueId}
                    view={mobileScreen.view}
                    labels={mobileScreen.labels}
                    state={mobileScreen.state}
                    assignee={mobileScreen.assignee}
                    sort={mobileScreen.sort}
                    onChangeView={(view) => updateListFilters({ view })}
                    onChangeFilters={(filters) => updateListFilters(filters)}
                    onSelectIssue={selectIssue}
                    onCreateIssue={() => openCreateDialog()}
                    onBack={mobileScreen.origin === "home" ? goBack : undefined}
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
                    currentUserLogin={currentUserLogin}
                    selectedIssueId={mobileScreen.returnToIssueId}
                    view={mobileScreen.view}
                    labels={mobileScreen.labels}
                    state={mobileScreen.state}
                    assignee={mobileScreen.assignee}
                    sort={mobileScreen.sort}
                    onChangeView={(view) => updateListFilters({ view })}
                    onChangeFilters={(filters) => updateListFilters(filters)}
                    onSelectIssue={selectIssue}
                    onBack={goBack}
                    onCreateIssue={() => openCreateDialog(mobileScreen.repository.fullName)}
                  />
                )}

                {mobileScreen.kind === "issue-detail" && (
                  <MobileIssueDetail
                    issue={mobileScreen.issue}
                    issues={issues}
                    repositories={visibleRepositories}
                    onBack={goBack}
                    onEdit={setEditingIssue}
                    onIssueUpdated={handleIssueUpdated}
                    onIssueDeleted={handleIssueDeleted}
                    onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
                    onCreateIssue={(repositoryFullName) => openCreateDialog(repositoryFullName)}
                    onCreateFollowupIssue={openFollowupIssueDialog}
                  />
                )}
              </>
            )}
          </div>

          <MobileBottomNav active={activeBottomNavTab} onSelect={selectTab} />
        </div>

        {/* PC: 左カラム（ナビゲーション）。手動で開閉・幅調整ができる（#381） */}
        {!isSidebarCollapsed && (
          <>
            <SidebarNav
              activeView={filters.view}
              onSelectView={handleSelectView}
              navCounts={navCounts}
              repositories={repositories}
              selectedRepoFullName={filters.repo}
              onSelectRepository={(repo) => setFilter("repo", repo.fullName)}
              onClearRepository={() => setFilter("repo", null)}
              onHideRepository={(repo) => handleSetRepositoryHidden(repo, true)}
              onShowRepository={(repo) => handleSetRepositoryHidden(repo, false)}
              onOpenRepositorySettings={setRepositorySettingsTarget}
              labelSummary={labelSummary}
              selectedLabels={filters.labels}
              onSelectLabel={(label) => toggleLabel(label.name)}
              onClearLabels={() => setFilter("labels", [])}
              quickFilters={quickFilters}
              onSelectQuickFilter={handleSelectQuickFilter}
              onDeleteQuickFilter={handleDeleteQuickFilter}
              onSaveQuickFilter={() => setQuickFilterDialogOpen(true)}
              className="hidden shrink-0 border-r md:flex"
              style={{ width: sidebarWidth.width, maxWidth: "50vw" }}
            />
            <ResizeHandle onDragStart={sidebarWidth.handleDragStart} className="hidden md:block" />
          </>
        )}

        {/* PC: 中央カラム（Issue一覧）。幅は手動で調整できる（#381） */}
        <IssueList
          title={getNavViewLabel(filters.view)}
          issues={filteredIssues}
          selectedIssueId={selectedIssue?.id ?? null}
          onSelectIssue={setSelectedIssue}
          showSearch={false}
          className="hidden shrink-0 border-r md:flex"
          style={{ width: issueListWidth.width, maxWidth: "50vw" }}
        />
        <ResizeHandle onDragStart={issueListWidth.handleDragStart} className="hidden md:block" />

        {/* PC: 右カラム（Issue詳細 + プロパティパネル） */}
        <div className="hidden flex-1 overflow-hidden md:flex">
          <IssueDetail
            issue={selectedIssue}
            issues={issues}
            repositories={visibleRepositories}
            onEdit={setEditingIssue}
            onIssueUpdated={handleIssueUpdated}
            onIssueDeleted={handleIssueDeleted}
            onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
            onCreateFollowupIssue={openFollowupIssueDialog}
          />
        </div>
        {selectedIssue && (
          <>
            <ResizeHandle
              onDragStart={propertiesPanelWidth.handleDragStart}
              className="hidden xl:block"
            />
            <div
              className="hidden shrink-0 border-l xl:block"
              style={{ width: propertiesPanelWidth.width, maxWidth: "50vw" }}
            >
              <IssuePropertiesPanel
                issue={selectedIssue}
                repositories={visibleRepositories}
                onIssueUpdated={handleIssueUpdated}
              />
            </div>
          </>
        )}
      </div>

      <CreateIssueDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        repositories={visibleRepositories}
        defaultRepositoryFullName={createDialogRepo}
        defaultBody={createDialogBody}
        issues={issues}
        onCreated={handleIssueCreated}
      />
      <QuickFilterDialog
        open={quickFilterDialogOpen}
        onOpenChange={setQuickFilterDialogOpen}
        filters={filters}
        onCreated={(quickFilter) => setQuickFilters((prev) => [...prev, quickFilter])}
      />
      <RepositorySettingsDialog
        repository={repositorySettingsTarget}
        onOpenChange={(open) => {
          if (!open) setRepositorySettingsTarget(null);
        }}
        onUpdated={handleRepositorySettingsUpdated}
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
