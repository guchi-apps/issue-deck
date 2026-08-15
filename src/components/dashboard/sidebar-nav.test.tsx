// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { navViews } from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { getPullRequestView } from "@/lib/pull-request-views";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";

const NAV_COUNTS = Object.fromEntries(navViews.map((view) => [view.id, 0])) as Record<
  NavViewId,
  number
>;

function renderSidebar(
  pullRequestNavCounts: PullRequestNavCounts,
  navCounts: Record<NavViewId, number> = NAV_COUNTS,
) {
  render(
    <SidebarNav
      activeView="all"
      onSelectView={() => {}}
      activePane="issues"
      activePullRequestView="all"
      onSelectPullRequestView={() => {}}
      onSelectFlow={() => {}}
      navCounts={navCounts}
      pullRequestNavCounts={pullRequestNavCounts}
      repositories={[]}
      labelSummary={[]}
      quickFilters={[]}
      onSelectQuickFilter={() => {}}
      onDeleteQuickFilter={() => {}}
      onSaveQuickFilter={() => {}}
    />,
  );
}

/** PRビューのボタンは判定条件の補足をtitle属性に持つので、それを手掛かりに引く */
function pullRequestNavItem(view: PullRequestViewId) {
  return screen.getByTitle(getPullRequestView(view).description);
}

afterEach(() => cleanup());

describe("SidebarNav", () => {
  it("処理中・完了のPRは件数を出す", () => {
    renderSidebar({ all: null, "in-progress": 3, completed: 1 });

    expect(pullRequestNavItem("in-progress").textContent).toContain("3");
    expect(pullRequestNavItem("completed").textContent).toContain("1");
  });

  it("0件でも件数を出す（Issue側の項目と揃える）", () => {
    renderSidebar({ all: null, "in-progress": 0, completed: 0 });

    expect(pullRequestNavItem("in-progress").textContent).toContain("0");
  });

  // 母集団がscope依存で「全PR数」として読める数にならないため（#1389）。
  it("全てのPRには件数を出さない", () => {
    renderSidebar({ all: null, "in-progress": 3, completed: 1 });

    expect(pullRequestNavItem("all").textContent).toBe(getPullRequestView("all").label);
  });

  // 行全体をamberで塗ると選択中の行と紛らわしく、ラベル文字の色も他のビューと揃わない（#1443）。
  it("確認待ちが残っていても強調するのは件数バッジだけにする", () => {
    renderSidebar(
      { all: null, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, "check-user": 2 },
    );

    const button = screen.getByRole("button", { name: /ユーザーの確認待ち/ });
    expect(button.className).not.toContain("amber");
    const badge = screen.getByText("2");
    expect(badge.className).toContain("bg-amber-500");
  });

  // 取得前に0を出すと「PRが無い」と読めてしまうため。
  it("未取得のときはどのPRビューにも件数を出さない", () => {
    renderSidebar({ all: null, "in-progress": null, completed: null });

    for (const view of ["all", "in-progress", "completed"] as const) {
      expect(pullRequestNavItem(view).textContent).toBe(getPullRequestView(view).label);
    }
  });
});
