// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    navCounts: PullRequestNavCounts;
    origin: "tab" | "home";
    onChangeView: (view: PullRequestViewId) => void;
    onBack: () => void;
    onRefresh: () => Promise<unknown> | void;
  }> = {},
) {
  render(
    <MobilePullRequestsScreen
      view={overrides.view ?? "in-progress"}
      navCounts={overrides.navCounts ?? NAV_COUNTS}
      origin={overrides.origin ?? "tab"}
      pullRequests={[]}
      failedRepositories={[]}
      fetchedAt="2026-08-14T10:30:00Z"
      isLoading={false}
      autoRefreshIntervalMs={null}
      error={null}
      onRefresh={overrides.onRefresh ?? vi.fn()}
      onBack={overrides.onBack ?? vi.fn()}
      onChangeView={overrides.onChangeView ?? vi.fn()}
      onSelectPullRequest={vi.fn()}
      onMerged={vi.fn()}
    />,
  );
}

/** 下端のビュー行（シートを開くボタン） */
function viewRow() {
  return screen.getByRole("button", { name: /実行中|すべてのPR|マージ待ち/ });
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

    // 「マージ待ち」はシートを開くまで画面に無い
    expect(screen.queryByRole("button", { name: /マージ待ち/ })).toBeNull();
  });

  it("行を押して開くシートからビューを選べる", () => {
    const onChangeView = vi.fn();
    renderScreen({ onChangeView });

    fireEvent.click(viewRow());
    fireEvent.click(screen.getByRole("button", { name: /マージ待ち/ }));

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

  it("フッターのタブから開いた場合は、右スワイプで戻らない（#1691）", () => {
    // PR一覧は`origin`によらず`onBack`が渡ってくる（Issue一覧と違う）。判定を`onBack`の
    // 有無にすると、戻る先が無いタブ経由でもホームへ抜けてしまう。
    const onBack = vi.fn();
    const onChangeView = vi.fn();
    renderScreen({ view: "in-progress", origin: "tab", onBack, onChangeView });

    swipe(120);

    expect(onBack).not.toHaveBeenCalled();
    expect(onChangeView).toHaveBeenCalledWith("all");
  });

  it("端のビューではそれ以上切り替えない", () => {
    const onChangeView = vi.fn();
    renderScreen({ view: "all", onChangeView });

    swipe(120);

    expect(onChangeView).not.toHaveBeenCalled();
  });
});

// #1947。更新の口はヘッダーのボタンではなく、引っ張って更新と自動更新にそろえた
describe("MobilePullRequestsScreen の更新（#1947）", () => {
  afterEach(() => {
    cleanup();
  });

  it("ヘッダーに「更新」ボタンを出さない", () => {
    renderScreen();

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });
});

// ビュー選択シートの件数も、PCの左メニュー・ホームと同じ判定で強調する（#2334）
describe("MobilePullRequestsScreen のビュー選択シートの強調（#2334）", () => {
  afterEach(() => {
    cleanup();
  });

  /** シートを開いて、そのビューの行に出ている件数のバッジを返す */
  function sheetBadge(label: RegExp) {
    fireEvent.click(viewRow());
    // 下端のビュー行にも同じ文言が出るため、シート（ダイアログ）の中だけを見る
    const row = within(screen.getByRole("dialog")).getByRole("button", { name: label });
    return row.querySelectorAll("span")[1];
  }

  it("マージ待ちが残っていれば件数をオレンジの丸で出す", () => {
    renderScreen();

    expect(sheetBadge(/マージ待ち/)?.className).toContain("bg-amber-500");
  });

  it("マージ待ちが0件なら丸にしない", () => {
    renderScreen({ navCounts: { all: 2, "in-progress": 2, completed: 0 } });

    expect(sheetBadge(/マージ待ち/)?.className).not.toContain("bg-amber-500");
  });

  it("実行中は件数があっても丸にしない", () => {
    renderScreen();

    expect(sheetBadge(/実行中/)?.className).not.toContain("bg-amber-500");
  });
});
