"use client";

import { useMemo, useState } from "react";

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
import { CURRENT_USER_LOGIN, mockIssues, navViews } from "@/lib/mock-data";
import type { MockIssue, MockRepository, NavViewId } from "@/types/issue";
import type { CurrentUser } from "@/types/user";

function filterIssuesByView(issues: MockIssue[], view: NavViewId): MockIssue[] {
  switch (view) {
    case "assigned":
      return issues.filter((issue) => issue.assignee?.login === CURRENT_USER_LOGIN);
    case "created":
      return issues.filter((issue) => issue.author.login === CURRENT_USER_LOGIN);
    case "favorites":
      return issues.slice(0, 1);
    case "recent":
      return [...issues].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    case "all":
    default:
      return issues;
  }
}

type MobileScreen =
  | { kind: "home" }
  | { kind: "view"; view: NavViewId }
  | { kind: "repo"; repository: MockRepository }
  | { kind: "issue"; issue: MockIssue; back: MobileScreen }
  | { kind: "placeholder"; tab: MobileBottomNavTab; label: string };

type IssueDeckShellProps = {
  currentUser: CurrentUser | null;
};

export function IssueDeckShell({ currentUser }: IssueDeckShellProps) {
  const [activeView, setActiveView] = useState<NavViewId>("all");
  const [selectedIssue, setSelectedIssue] = useState<MockIssue | null>(null);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>({ kind: "home" });

  const filteredIssues = useMemo(
    () => filterIssuesByView(mockIssues, activeView),
    [activeView],
  );

  function handleSelectView(view: NavViewId) {
    setActiveView(view);
    setSelectedIssue(null);
  }

  function handleMobileSelectView(view: NavViewId) {
    setMobileScreen({ kind: "view", view });
  }

  function handleMobileSelectRepository(repository: MockRepository) {
    setMobileScreen({ kind: "repo", repository });
  }

  function handleMobileSelectIssue(issue: MockIssue) {
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
                onSelectRepository={handleMobileSelectRepository}
              />
            )}

            {mobileScreen.kind === "view" && (
              <MobileViewIssuesScreen
                title={navViews.find((view) => view.id === mobileScreen.view)?.label ?? ""}
                issues={filterIssuesByView(mockIssues, mobileScreen.view)}
                selectedIssueId={null}
                onSelectIssue={handleMobileSelectIssue}
                onBack={handleMobileBack}
              />
            )}

            {mobileScreen.kind === "repo" && (
              <MobileRepoIssuesScreen
                repository={mobileScreen.repository}
                issues={mockIssues}
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
