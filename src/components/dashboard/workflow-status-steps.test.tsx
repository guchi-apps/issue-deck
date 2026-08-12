// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowStatusSteps } from "@/components/dashboard/workflow-status-steps";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

describe("WorkflowStatusSteps", () => {
  afterEach(() => {
    cleanup();
  });

  it("Project Statusが無い場合は何も表示しない", () => {
    const { container } = render(<WorkflowStatusSteps labels={labels("bug")} />);
    expect(container.firstChild).toBeNull();
  });

  it("現在ステップの名称と番号をスマホ向けキャプションに表示する", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Implementation" />);
    expect(screen.getByText("実装中（2/6）")).not.toBeNull();
  });

  it("ユーザー確認待ちの場合はキャプション付近にも確認待ち表示を出す", () => {
    render(<WorkflowStatusSteps labels={labels("00.check-user")} projectStatus="Implementation" />);
    expect(screen.getAllByText("ユーザー確認待ち").length).toBeGreaterThan(0);
  });

  it("各ステップの円にaria-currentが付き、完了済みステップと現在ステップが判別できる", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Develop PR" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[2].getAttribute("aria-current")).toBe("step");
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[0].title).toBe("Planning");
  });
});
