// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssueListScreen } from "@/components/dashboard/mobile/mobile-issue-list-screen";
import type { MobileIssueLocalFilters } from "@/components/dashboard/mobile/mobile-issue-filter-sheet";
import { navViews } from "@/lib/nav-views";
import type { NavViewId } from "@/types/issue";

// 一覧本体はこの画面の関心事ではない（取得系フックを丸ごと抱えるため）ので差し替える。
// 先頭の固定枠（#1713）だけは、どのビューで描かれるかをここで確かめるため通す。
vi.mock("@/components/dashboard/issue-list", () => ({
  IssueList: ({
    pinnedSection,
    onPullToRefresh,
  }: {
    pinnedSection?: ReactNode;
    onPullToRefresh?: () => Promise<unknown> | void;
  }) => (
    <div data-testid="issue-list">
      {/* 引っ張って更新（#1893）は、この画面から一覧へ渡っているかだけをここで確かめる。
          ジェスチャーの判定そのものは実DOMを使うuse-pull-to-refresh.test.tsxが見る */}
      {onPullToRefresh && (
        <button type="button" onClick={() => void onPullToRefresh()}>
          引っ張って更新
        </button>
      )}
      {pinnedSection}
    </div>
  ),
}));

const NAV_COUNTS = Object.fromEntries(
  navViews.map((view) => [view.id, view.id === "check-user" ? 3 : 7]),
) as Record<NavViewId, number>;

const NO_FILTERS: MobileIssueLocalFilters = {
  state: "open",
  labels: [],
  assignee: null,
  sort: "created",
};

function renderScreen(
  overrides: Partial<{
    view: NavViewId;
    filters: MobileIssueLocalFilters;
    onChangeView: (view: NavViewId) => void;
    onChangeFilters: (filters: MobileIssueLocalFilters) => void;
    pinned: { view: NavViewId; count: number; section: ReactNode };
    onRefresh: () => Promise<unknown> | void;
  }> = {},
) {
  render(
    <MobileIssueListScreen
      title="Issue"
      issues={[]}
      navCounts={NAV_COUNTS}
      selectedIssueId={null}
      view={overrides.view ?? "all"}
      filters={overrides.filters ?? NO_FILTERS}
      labelOptions={[]}
      assigneeOptions={[]}
      onChangeView={overrides.onChangeView ?? vi.fn()}
      onChangeFilters={overrides.onChangeFilters ?? vi.fn()}
      onSelectIssue={vi.fn()}
      onCreateIssue={vi.fn()}
      pinned={overrides.pinned}
      scrollKey="test"
      onRefresh={overrides.onRefresh}
    />,
  );
}

const MERGE_PENDING_PINNED = {
  view: "check-user" as NavViewId,
  count: 2,
  section: <div data-testid="merge-pending">マージ待ちPR</div>,
};

describe("MobileIssueListScreen の絞り込み行（#1645）", () => {
  afterEach(() => {
    cleanup();
  });

  // 通知ベル（#1772）。実行状況を置いている画面には同じように置く
  it("ヘッダーに通知ベルを出す", () => {
    renderScreen({ view: "in-progress" });

    expect(screen.getByRole("button", { name: "対応が必要なもの" })).toBeTruthy();
  });

  it("表示中のビュー名と件数をボタンに出す", () => {
    renderScreen({ view: "in-progress" });

    expect(screen.getByRole("button", { name: /実行中/ }).textContent).toContain("実行中");
    expect(screen.getByRole("button", { name: /実行中/ }).textContent).toContain("7");
  });

  it("ヘッダーの件数行にもビュー名を添える", () => {
    renderScreen({ view: "check-user" });

    expect(screen.getByText("ユーザーの確認待ち・0件")).toBeTruthy();
  });

  it("絞り込みが効いているときだけ件数バッジを出す", () => {
    renderScreen();
    expect(screen.getByRole("button", { name: /絞り込み/ }).textContent).toBe("絞り込み");
    cleanup();

    renderScreen({
      filters: { ...NO_FILTERS, state: "closed", labels: ["30.bug"] },
    });
    expect(screen.getByRole("button", { name: /絞り込み/ }).textContent).toBe("絞り込み2");
  });

  it("ビュー選択シートには一覧に出すビューだけを並べ、選ぶと切り替える", () => {
    const onChangeView = vi.fn();
    renderScreen({ onChangeView });

    fireEvent.click(screen.getByRole("button", { name: /すべてのIssue/ }));

    expect(screen.getByText("表示するIssue")).toBeTruthy();
    // 本番反映待ちは#1743で一覧へ戻した。出さないのは「直近本番に反映した」だけ
    expect(screen.getByRole("button", { name: /本番反映待ち/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /直近本番に反映した/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /未着手/ }));
    expect(onChangeView).toHaveBeenCalledWith("not-started");
  });

  it("一覧に無いビューで開かれた場合は、そのビューもシートに並べる", () => {
    renderScreen({ view: "recently-merged" });

    fireEvent.click(screen.getByRole("button", { name: /直近本番に反映した/ }));

    // シートを開くと背景はaria-hiddenになるため、ここで引ける行はシート内の行
    expect(screen.getByText("表示するIssue")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /直近本番に反映した/ }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("固定表示ぶんを、ヘッダーの件数とビュー行の件数へ合流させる（#1713）", () => {
    renderScreen({ view: "check-user", pinned: MERGE_PENDING_PINNED });

    // Issueは0件でも、マージ待ちPRが2件あればホーム画面と同じ2件と出す
    expect(screen.getByText("ユーザーの確認待ち・2件")).toBeTruthy();
    expect(screen.getByTestId("merge-pending")).toBeTruthy();
    // ビュー行はビューごとの件数（3件）に固定表示ぶんを足した5件
    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toContain("5");
  });

  it("対象ビュー以外では固定表示を出さず、ヘッダーの件数にも足さない（#1713）", () => {
    renderScreen({ view: "all", pinned: MERGE_PENDING_PINNED });

    expect(screen.getByText("すべてのIssue・0件")).toBeTruthy();
    expect(screen.queryByTestId("merge-pending")).toBeNull();

    // ただしビュー選択シートの「ユーザーの確認待ち」は合流後の件数を出す。切り替えた途端に
    // 件数が変わると、確認待ちの件数だけがまた食い違って見える
    fireEvent.click(screen.getByRole("button", { name: /すべてのIssue/ }));
    expect(
      screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent,
    ).toContain("5");
  });

  it("絞り込みシートの「すべて解除」で状態・ラベル・担当者だけを既定へ戻す", () => {
    const onChangeFilters = vi.fn();
    renderScreen({
      filters: { state: "closed", labels: ["30.bug"], assignee: "guchi", sort: "updated" },
      onChangeFilters,
    });

    fireEvent.click(screen.getByRole("button", { name: /絞り込み/ }));
    fireEvent.click(screen.getByRole("button", { name: /すべて解除/ }));

    expect(onChangeFilters).toHaveBeenCalledWith({
      state: "open",
      labels: [],
      assignee: null,
      sort: "updated",
    });
  });

  // 引っ張って更新（#1893）
  it("一覧へ引っ張って更新を渡し、実行するとIssueを取り直す", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    renderScreen({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "引っ張って更新" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("取り直しを渡さない画面では引っ張って更新を有効にしない", () => {
    renderScreen();

    expect(screen.queryByRole("button", { name: "引っ張って更新" })).toBeNull();
  });
});
