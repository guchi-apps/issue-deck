// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkDispatchBar } from "@/components/dashboard/bulk-dispatch-bar";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { START_IMPLEMENTATION_OPTIONS } from "@/lib/github/start-implementation";
import type { Issue } from "@/types/issue";

const updateIssue = vi.fn().mockResolvedValue(null);
vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({ updateIssue }),
}));

/** リポジトリごとの定義済みラベル。テストから差し替える */
const labelNames: { byRepository: Map<string, readonly string[]>; isLoading: boolean } = {
  byRepository: new Map(),
  isLoading: false,
};
vi.mock("@/hooks/use-repository-label-names", () => ({
  useRepositoryLabelNames: () => ({
    labelNamesByRepository: labelNames.byRepository,
    isLoading: labelNames.isLoading,
  }),
}));

const ALL_LABELS = START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel);

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    online: true,
    repositories: ["guchi-apps/issue-deck"],
    ...overrides,
  } as DispatchHostView;
}

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(number),
    number,
    title: `Issue ${number}`,
    state: "open",
    repositoryFullName: "guchi-apps/issue-deck",
    labels: [],
    ...overrides,
  } as Issue;
}

function dispatchHandle(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [host()],
    jobs: [],
    sessions: [],
    error: null,
    enqueue: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as DispatchStateHandle;
}

afterEach(() => {
  cleanup();
  updateIssue.mockClear();
  labelNames.byRepository = new Map();
  labelNames.isLoading = false;
});

describe("BulkDispatchBarのオプション（#1993）", () => {
  it("選んだ条件を、選んだIssueすべてへ同じように付ける", async () => {
    labelNames.byRepository = new Map([["guchi-apps/issue-deck", ALL_LABELS]]);
    const enqueue = vi.fn().mockResolvedValue(true);
    render(
      <BulkDispatchBar
        issues={[issue(1), issue(2)]}
        dispatch={dispatchHandle({ enqueue })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /計画が必要/ }));
    fireEvent.click(screen.getByRole("button", { name: /へ順に積む/ }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1,
      labels: ["21.plan-required", "11.local"],
    });
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 2,
      labels: ["21.plan-required", "11.local"],
    });
  });

  // 片方にしか定義が無いラベルを一括で配ると、無い側では**その場で作られてしまう**（#1490）
  it("選んだIssueで共通して選べるものだけを出す", () => {
    labelNames.byRepository = new Map([
      ["guchi-apps/issue-deck", ALL_LABELS],
      ["guchi-apps/dayspan", ["21.plan-required"]],
    ]);
    render(
      <BulkDispatchBar
        issues={[issue(1), issue(2, { repositoryFullName: "guchi-apps/dayspan" })]}
        dispatch={dispatchHandle()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /計画が必要/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /マージ前に確認が必要/ })).toBeNull();
  });

  // 取得の途中で出すと、押そうとしたチップが指の下で入れ替わる（#1666と同じ理由）
  it("ラベル定義が確定するまでオプションを出さない", () => {
    labelNames.isLoading = true;
    render(
      <BulkDispatchBar
        issues={[issue(1)]}
        dispatch={dispatchHandle()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  // 先頭のIssueだけで判定すると、そのリポジトリがcloneされていないだけで全体が積めなくなる
  it("選んだうち1件でも積めれば押せる", () => {
    render(
      <BulkDispatchBar
        issues={[issue(1, { repositoryFullName: "guchi-apps/dayspan" }), issue(2)]}
        dispatch={dispatchHandle()}
        onClose={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /へ順に積む/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("1件も積めなければ押せない", () => {
    render(
      <BulkDispatchBar
        issues={[issue(1, { repositoryFullName: "guchi-apps/dayspan" })]}
        dispatch={dispatchHandle()}
        onClose={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", {
      name: "積める起動先がありません",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
