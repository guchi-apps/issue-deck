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
import { MobileRepoIssuesScreen } from "@/components/dashboard/mobile/mobile-repo-issues-screen";
import { MobileViewIssuesScreen } from "@/components/dashboard/mobile/mobile-view-issues-screen";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar } from "@/components/dashboard/topbar";
import type { FetchIssuesError } from "@/lib/github/fetch-dashboard-issues";
import {
  computeLabelSummary,
  computeNavCounts,
  computeOverviewStats,
  filterIssuesByView,
} from "@/lib/issue-stats";
import { navViews } from "@/lib/nav-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type MobileScreen =
  | { kind: "home" }
  | { kind: "view"; view: NavViewId }
  | { kind: "repo"; repository: ConnectedRepository }
  | { kind: "issue"; issue: Issue; back: MobileScreen }
  | { kind: "placeholder"; tab: MobileBottomNavTab; label: string };

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
  const [activeView, setActiveView] = useState<NavViewId>("all");
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>({ kind: "home" });
  const [errorBannerDismissed, setErrorBannerDismissed] = useState(false);

  const currentUserLogin = currentUser?.login ?? null;

  const filteredIssues = useMemo(
    () => filterIssuesByView(issues, activeView, currentUserLogin),
    [issues, activeView, currentUserLogin],
  );
  const navCounts = useMemo(
    () => computeNavCounts(issues, currentUserLogin),
    [issues, currentUserLogin],
  );
  const overviewStats = useMemo(() => computeOverviewStats(issues, currentUserLogin), [
    issues,
    currentUserLogin,
  ]);
  const labelSummary = useMemo(() => computeLabelSummary(issues), [issues]);

  function handleSelectView(view: NavViewId) {
    setActiveView(view);
    setSelectedIssue(null);
  }

  function handleMobileSelectView(view: NavViewId) {
    setMobileScreen({ kind: "view", view });
  }

  function handleMobileSelectRepository(repository: ConnectedRepository) {
    setMobileScreen({ kind: "repo", repository });
  }

  function handleMobileSelectIssue(issue: Issue) {
    setMobileScreen((prev) => ({ kind: "issue", issue, back: prev }));
  }

  function handleMobileBack() {
    setMobileScreen((prev) => (prev.kind === "issue" ? prev.back : { kind: "home" }));
  }

  function handleBottomNavSelect(tab: MobileBottomNavTab) {
    if (tab === "home" || tab === "repos") {
      setMobileScreen({ kind: "home" });
      return;
    }
    const label = tab === "notifications" ? "通知" : "設定";
    setMobileScreen({ kind: "placeholder", tab, label });
  }

  const activeBottomNavTab: MobileBottomNavTab =
    mobileScreen.kind === "placeholder" ? mobileScreen.tab : "home";

  return (
    <div className="flex h-dvh flex-col">
      <TopBar currentUser={currentUser} />

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
        {/* スマホ: 画面遷移型 */}
        <div className="flex flex-1 flex-col overflow-hidden md:hidden">
          <div className="flex-1 overflow-hidden">
            {mobileScreen.kind === "home" && (
              <MobileHomeScreen
                activeView={activeView}
                onSelectView={(view) => {
                  setActiveView(view);
                  handleMobileSelectView(view);
                }}
                navCounts={navCounts}
                repositories={repositories}
                onSelectRepository={handleMobileSelectRepository}
                labelSummary={labelSummary}
                overviewStats={overviewStats}
              />
            )}

            {mobileScreen.kind === "view" && (
              <MobileViewIssuesScreen
                title={navViews.find((view) => view.id === mobileScreen.view)?.label ?? ""}
                issues={filterIssuesByView(issues, mobileScreen.view, currentUserLogin)}
                selectedIssueId={null}
                onSelectIssue={handleMobileSelectIssue}
                onBack={handleMobileBack}
              />
            )}

            {mobileScreen.kind === "repo" && (
              <MobileRepoIssuesScreen
                repository={mobileScreen.repository}
                issues={issues}
                selectedIssueId={null}
                onSelectIssue={handleMobileSelectIssue}
                onBack={handleMobileBack}
              />
            )}

            {mobileScreen.kind === "issue" && (
              <MobileIssueDetail issue={mobileScreen.issue} onBack={handleMobileBack} />
            )}

            {mobileScreen.kind === "placeholder" && (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {mobileScreen.label}は準備中です
              </div>
            )}
          </div>

          <MobileBottomNav active={activeBottomNavTab} onSelect={handleBottomNavSelect} />
        </div>

        {/* PC: 左カラム（ナビゲーション） */}
        <SidebarNav
          activeView={activeView}
          onSelectView={handleSelectView}
          navCounts={navCounts}
          repositories={repositories}
          labelSummary={labelSummary}
          className="hidden w-60 shrink-0 border-r md:flex"
        />

        {/* PC: 中央カラム（Issue一覧） */}
        <IssueList
          title={navViews.find((view) => view.id === activeView)?.label ?? ""}
          issues={filteredIssues}
          selectedIssueId={selectedIssue?.id ?? null}
          onSelectIssue={setSelectedIssue}
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
