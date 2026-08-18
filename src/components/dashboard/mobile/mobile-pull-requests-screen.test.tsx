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

/** 下端のビュー行（シートを開くボタン） */
function viewRow() {
  return screen.getByRole("button", { name: /実行中|すべてのPR|完了したPR/ });
}

describe("MobilePullRequestsScreen のビュー切り替え（#1691）", () => {
  afterEach(() => {
    cleanup();
  });

  it("下端の行に表示中のビュー名と件数を出す", () => {
    renderScreen();

    expect(viewRow().textContent).toBe("実行中2");
  });

  it("件数を持たないビュー（すべてのPR）は件数を添えない", () => {
    renderScreen({ view: "all" });

    expect(viewRow().textContent).toBe("すべてのPR");
  });

  it("上部の横スクロールタブは出さない（切り替えの口を1つにする）", () => {
    renderScreen();

    // 「完了したPR」はシートを開くまで画面に無い
    expect(screen.queryByRole("button", { name: /完了したPR/ })).toBeNull();
  });

  it("行を押して開くシートからビューを選べる", () => {
    const onChangeView = vi.fn();
    renderScreen({ onChangeView });

    fireEvent.click(viewRow());
    fireEvent.click(screen.getByRole("button", { name: /完了したPR/ }));

    expect(onChangeView).toHaveBeenCalledWith("completed");
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

describe("MobilePullRequestsScreen のスワイプ（#1691）", () => {
  afterEach(() => {
    cleanup();
  });

  function swipe(deltaX: number) {
    const surface = viewRow().closest("div.flex.h-full") as HTMLElement;
    fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 400 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 200 + deltaX, clientY: 400 }] });
    fireEvent.touchEnd(surface);
  }

  it("左へスワイプすると次のビューへ切り替える", () => {
    const onChangeView = vi.fn();
    renderScreen({ view: "in-progress", onChangeView });

    swipe(-120);

    expect(onChangeView).toHaveBeenCalledWith("completed");
  });

  it("右へスワイプすると前のビューへ切り替える", () => {
    const onChangeView = vi.fn();
    renderScreen({ view: "in-progress", onChangeView });

    swipe(120);

    expect(onChangeView).toHaveBeenCalledWith("all");
  });

  it("端のビューではそれ以上切り替えない", () => {
    const onChangeView = vi.fn();
    renderScreen({ view: "all", onChangeView });

    swipe(120);

    expect(onChangeView).not.toHaveBeenCalled();
  });
});
