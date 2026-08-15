// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { navViews } from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { getPullRequestView } from "@/lib/pull-request-views";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

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

function repository(name: string, overrides: Partial<ConnectedRepository> = {}): ConnectedRepository {
  return {
    id: name,
    name,
    fullName: `guchi-apps/${name}`,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

function renderSidebarWithRepositories(
  repositories: ConnectedRepository[],
  selectedRepoFullNames: string[] = [],
) {
  render(
    <SidebarNav
      activeView="all"
      onSelectView={() => {}}
      activePane="issues"
      activePullRequestView="all"
      onSelectPullRequestView={() => {}}
      navCounts={NAV_COUNTS}
      pullRequestNavCounts={{ all: null, "in-progress": 0, completed: 0 }}
      repositories={repositories}
      selectedRepoFullNames={selectedRepoFullNames}
      labelSummary={[]}
      quickFilters={[]}
      onSelectQuickFilter={() => {}}
      onDeleteQuickFilter={() => {}}
      onSaveQuickFilter={() => {}}
    />,
  );
}

/** リポジトリ一覧に並んでいる名前を、表示順のまま取り出す（区切り線の行は空なので除く） */
function repositoryNamesInOrder() {
  const list = screen.getByRole("heading", { name: "リポジトリ" }).closest("div")
    ?.parentElement?.querySelector("ul");
  if (!list) throw new Error("リポジトリ一覧が見つかりません");
  return Array.from(list.querySelectorAll("li"))
    .map((item) => item.textContent?.trim() ?? "")
    .filter((text) => text.length > 0);
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

  // 連携数が増えると選択中の行がスクロール範囲の外へ出てしまうため（#1480）。
  it("選択中のリポジトリを一覧の先頭に並べる", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta"), repository("gamma")],
      ["guchi-apps/gamma"],
    );

    expect(repositoryNamesInOrder()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("選択が無いときは渡された並び順のまま出す", () => {
    renderSidebarWithRepositories([repository("alpha"), repository("beta"), repository("gamma")]);

    expect(repositoryNamesInOrder()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("複数選択でもグループ内の並び順は変えない", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta"), repository("gamma"), repository("delta")],
      ["guchi-apps/gamma", "guchi-apps/alpha"],
    );

    expect(repositoryNamesInOrder()).toEqual(["alpha", "gamma", "beta", "delta"]);
  });

  // 行が消えると選択だけが残り、その行から解除できなくなるため（#1480）。
  it("非表示のリポジトリでも選択中なら一覧に出す", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta", { hidden: true })],
      ["guchi-apps/beta"],
    );

    expect(repositoryNamesInOrder()).toEqual(["beta", "alpha"]);
    // 表示済みの1件を数に含めると、押しても増えない件数を出してしまう
    expect(screen.queryByText(/すべて表示する/)).toBeNull();
  });
});
