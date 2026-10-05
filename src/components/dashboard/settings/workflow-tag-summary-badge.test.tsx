// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowTagSummaryBadge } from "@/components/dashboard/settings/workflow-tag-summary-badge";
import type { WorkflowTagsState } from "@/components/dashboard/workflow-tag-status";

afterEach(cleanup);

function tags(overrides: Partial<WorkflowTagsState>): WorkflowTagsState {
  return {
    overview: null,
    fetchedAt: null,
    isLoading: false,
    error: null,
    isRunning: false,
    awaiting: false,
    isRepairRunning: false,
    isSharedFileRunning: false,
    reload: vi.fn(),
    markDispatched: vi.fn(),
    ...overrides,
  };
}

describe("WorkflowTagSummaryBadge", () => {
  it("初回取得中は確認中と文字で出し、押すと項目を開く", () => {
    const onOpen = vi.fn();
    render(<WorkflowTagSummaryBadge tags={tags({ isLoading: true })} onOpen={onOpen} />);

    fireEvent.click(screen.getByText("確認中"));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("取得失敗は最新ではなく確認できませんと出す", () => {
    render(<WorkflowTagSummaryBadge tags={tags({ error: "取得に失敗しました (500)" })} onOpen={vi.fn()} />);

    expect(screen.getByText("確認できません")).toBeTruthy();
    expect(screen.queryByText("最新")).toBeNull();
  });
});
