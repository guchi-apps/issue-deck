// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "@/components/dashboard/topbar";
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

function renderTopBar(setFilter: SetFilter, filters: IssueFilters = baseFilters) {
  return render(
    <TopBar
      currentUser={null}
      filters={filters}
      setFilter={setFilter}
      groupByRepo={false}
      onChangeGroupByRepo={() => {}}
      assigneeOptions={[]}
      onCreateIssue={() => {}}
      onAskCrossRepoQuestion={() => {}}
      repositories={[]}
      issues={[]}
      pullRequests={[]}
      onOpenNotificationTarget={() => {}}
      onOpenIssue={() => {}}
      onOpenCheckUserView={() => {}}
      onOpenFlow={() => {}}
      isSidebarCollapsed={false}
      onToggleSidebar={() => {}}
      onOpenSettings={() => {}}
    />,
  );
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

  it("クイックフィルター適用等でfilters.qが外部から変わった場合は表示に追随する", async () => {
    const setFilter = vi.fn();
    const { container, rerender } = renderTopBar(setFilter, { ...baseFilters, q: "foo" });
    const input = container.querySelector('input[placeholder="Issueを検索..."]') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("foo"));

    rerender(
      <TopBar
        currentUser={null}
        filters={{ ...baseFilters, q: "bar" }}
        setFilter={setFilter}
        groupByRepo={false}
        onChangeGroupByRepo={() => {}}
        assigneeOptions={[]}
        onCreateIssue={() => {}}
        onAskCrossRepoQuestion={() => {}}
        repositories={[]}
        issues={[]}
        pullRequests={[]}
        onOpenNotificationTarget={() => {}}
        onOpenIssue={() => {}}
        onOpenCheckUserView={() => {}}
        onOpenFlow={() => {}}
        isSidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => expect(input.value).toBe("bar"));
  });
});
