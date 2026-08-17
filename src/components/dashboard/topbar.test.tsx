// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopBar, type TopBarAiSearch } from "@/components/dashboard/topbar";
import type { IssueFilters } from "@/hooks/use-issue-filters";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const baseFilters: IssueFilters = {
  view: "all",
  pane: "issues",
  prview: "all",
  pr: null,
  issue: null,
  q: "",
  repos: [],
  state: "open",
  labels: [],
  assignee: null,
  sort: "created",
};

type SetFilter = <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => void;

const baseAiSearch: TopBarAiSearch = {
  canRun: false,
  isSearching: false,
  notConfigured: false,
  error: null,
  matchedCount: null,
  droppedCandidateCount: 0,
  run: () => {},
  clear: () => {},
};

function topBarProps(
  setFilter: SetFilter,
  filters: IssueFilters = baseFilters,
  back: { canGoBack?: boolean; onBack?: () => void } = {},
  aiSearch: Partial<TopBarAiSearch> = {},
) {
  return {
    currentUser: null,
    filters,
    setFilter,
    groupByRepo: false,
    onChangeGroupByRepo: () => {},
    assigneeOptions: [],
    onCreateIssue: () => {},
    onAskCrossRepoQuestion: () => {},
    onOpenNotificationTarget: () => {},
    onOpenIssue: () => {},
    onOpenCheckUserView: () => {},
    onOpenFlow: () => {},
    isSidebarCollapsed: false,
    onToggleSidebar: () => {},
    onOpenSettings: () => {},
    canGoBack: back.canGoBack ?? true,
    onBack: back.onBack ?? (() => {}),
    aiSearch: { ...baseAiSearch, ...aiSearch },
  };
}

function renderTopBar(
  setFilter: SetFilter,
  filters: IssueFilters = baseFilters,
  back: { canGoBack?: boolean; onBack?: () => void } = {},
  aiSearch: Partial<TopBarAiSearch> = {},
) {
  return render(<TopBar {...topBarProps(setFilter, filters, back, aiSearch)} />);
}

describe("TopBar 検索欄", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("入力は即座に表示へ反映されるが、URLへの反映（setFilter）はデバウンスされる（#1024）", async () => {
    vi.useFakeTimers();
    const setFilter = vi.fn();
    const { container } = renderTopBar(setFilter);
    const input = container.querySelector('input[placeholder="Issueを検索..."]') as HTMLInputElement;

    fireEvent.change(input, { target: { value: "b" } });
    expect(input.value).toBe("b");
    fireEvent.change(input, { target: { value: "bu" } });
    fireEvent.change(input, { target: { value: "bug" } });
    expect(input.value).toBe("bug");

    // デバウンス時間内は連続入力しても呼ばれない
    expect(setFilter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledWith("q", "bug");
  });

  it("ブラウザバック等でfilters.qが外部から変わった場合は表示に追随する", async () => {
    const setFilter = vi.fn();
    const { container, rerender } = renderTopBar(setFilter, { ...baseFilters, q: "foo" });
    const input = container.querySelector('input[placeholder="Issueを検索..."]') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("foo"));

    rerender(<TopBar {...topBarProps(setFilter, { ...baseFilters, q: "bar" })} />);

    await waitFor(() => expect(input.value).toBe("bar"));
  });
});

describe("TopBar 検索のクリアボタン（#1788）", () => {
  function findClearButton(container: HTMLElement) {
    return container.querySelector('button[aria-label="検索をクリア"]') as HTMLButtonElement | null;
  }

  it("入力が空のときは出さない", () => {
    const { container } = renderTopBar(vi.fn());

    expect(findClearButton(container)).toBeNull();
  });

  it("押すと入力とURLの検索条件を同時に消す（デバウンスを待たない）", async () => {
    const setFilter = vi.fn();
    const { container } = renderTopBar(setFilter, { ...baseFilters, q: "bug" });
    const input = container.querySelector('input[placeholder="Issueを検索..."]') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("bug"));

    const clearButton = findClearButton(container);
    expect(clearButton).not.toBeNull();
    fireEvent.click(clearButton as HTMLButtonElement);

    expect(input.value).toBe("");
    expect(setFilter).toHaveBeenCalledWith("q", "");
  });

  it("押すとAI検索の結果も解除する", async () => {
    const clear = vi.fn();
    const { container } = renderTopBar(vi.fn(), { ...baseFilters, q: "bug" }, {}, {
      canRun: true,
      matchedCount: 3,
      clear,
    });

    fireEvent.click(findClearButton(container) as HTMLButtonElement);

    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar AIあいまい検索（#1788）", () => {
  function findAiButton(container: HTMLElement) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "AIで探す" || button.textContent === "AI検索を解除",
    );
  }

  it("自由語が無いときは出さない", () => {
    const { container } = renderTopBar(vi.fn(), baseFilters, {}, { canRun: false });

    expect(findAiButton(container)).toBeUndefined();
  });

  it("押すとAI検索を実行する", () => {
    const run = vi.fn();
    const { container } = renderTopBar(vi.fn(), { ...baseFilters, q: "重い" }, {}, {
      canRun: true,
      run,
    });

    fireEvent.click(findAiButton(container) as HTMLButtonElement);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("AI検索中は件数を出し、もう一度押すと解除する", () => {
    const clear = vi.fn();
    const { container } = renderTopBar(vi.fn(), { ...baseFilters, q: "重い" }, {}, {
      canRun: true,
      matchedCount: 12,
      clear,
    });

    expect(container.textContent).toContain("AI検索: 12件");
    fireEvent.click(findAiButton(container) as HTMLButtonElement);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("トークンが未設定（501）と分かった後はボタンを出さない", () => {
    const { container } = renderTopBar(vi.fn(), { ...baseFilters, q: "重い" }, {}, {
      canRun: true,
      notConfigured: true,
    });

    expect(findAiButton(container)).toBeUndefined();
  });
});

describe("TopBar 戻るボタン（#1771）", () => {
  // このファイルはvitestのglobalsを使っておらず、テスト間の自動cleanupが働かない
  // （前のテストの描画結果がdocumentに残る）。取得はcontainer配下に閉じて行う。
  function findBackButton(container: HTMLElement) {
    return container.querySelector('button[aria-label="戻る"]') as HTMLButtonElement;
  }

  it("押すとonBackが呼ばれる", () => {
    const onBack = vi.fn();
    const { container } = renderTopBar(vi.fn(), baseFilters, { canGoBack: true, onBack });

    fireEvent.click(findBackButton(container));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("巻き戻せる履歴が無いときは、消さずに押せない状態で残す", () => {
    const onBack = vi.fn();
    const { container } = renderTopBar(vi.fn(), baseFilters, { canGoBack: false, onBack });

    const button = findBackButton(container);
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(onBack).not.toHaveBeenCalled();
  });
});
