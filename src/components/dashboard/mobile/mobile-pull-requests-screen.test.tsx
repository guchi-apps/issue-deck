// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobilePullRequestsScreen } from "@/components/dashboard/mobile/mobile-pull-requests-screen";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import type { PullRequestViewId } from "@/types/pull-request";

const NAV_COUNTS: PullRequestNavCounts = {
  all: null,
  "in-progress": 2,
  completed: 3,
};

function renderScreen(
  overrides: Partial<{
    view: PullRequestViewId;
    origin: "tab" | "home";
    onChangeView: (view: PullRequestViewId) => void;
    onBack: () => void;
  }> = {},
) {
  render(
    <MobilePullRequestsScreen
      view={overrides.view ?? "in-progress"}
      navCounts={NAV_COUNTS}
      origin={overrides.origin ?? "tab"}
      pullRequests={[]}
      failedRepositories={[]}
      fetchedAt="2026-08-14T10:30:00Z"
      isLoading={false}
      isRefreshing={false}
      autoRefreshIntervalMs={null}
      error={null}
      onRefresh={vi.fn()}
      onBack={overrides.onBack ?? vi.fn()}
      onChangeView={overrides.onChangeView ?? vi.fn()}
      onSelectPullRequest={vi.fn()}
      onMerged={vi.fn()}
    />,
  );
}

describe("MobilePullRequestsScreen のビュー切り替えタブ（#1436）", () => {
  afterEach(() => {
    cleanup();
  });

  it("3つの状態別ビューをタブに出し、件数を持つビューだけ件数を添える", () => {
    renderScreen();

    expect(screen.getByRole("button", { name: /すべてのPR/ }).textContent).toBe("すべてのPR");
    expect(screen.getByRole("button", { name: /実行中/ }).textContent).toBe("実行中2");
    expect(screen.getByRole("button", { name: /完了したPR/ }).textContent).toBe("完了したPR3");
  });

  it("表示中のビューのタブにaria-currentが付く", () => {
    renderScreen({ view: "completed" });

    expect(
      screen.getByRole("button", { name: /完了したPR/ }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("button", { name: /実行中/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("タブを押すとそのビューでonChangeViewを呼ぶ", () => {
    const onChangeView = vi.fn();
    renderScreen({ onChangeView });

    fireEvent.click(screen.getByRole("button", { name: /すべてのPR/ }));

    expect(onChangeView).toHaveBeenCalledWith("all");
  });

  it("フッターのタブから開いた場合は戻るボタンを出さず、ホーム経由なら出す", () => {
    renderScreen({ origin: "tab" });
    expect(screen.queryByRole("button", { name: "戻る" })).toBeNull();

    cleanup();

    const onBack = vi.fn();
    renderScreen({ origin: "home", onBack });
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(onBack).toHaveBeenCalled();
  });
});
