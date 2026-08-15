// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 1,
    metrics: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1638,
    issueTitle: "スマホ画面のレイアウト改善",
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "RUNNING",
    message: null,
    instruction: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeDispatch(overrides: {
  hosts?: DispatchHostView[];
  jobs?: DispatchJobView[];
  sessions?: DispatchSessionView[];
}): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [],
    jobs: overrides.jobs ?? [],
    sessions: overrides.sessions ?? [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    prioritize: vi.fn(),
  } as unknown as DispatchStateHandle;
}

afterEach(() => {
  cleanup();
});

describe("MobileDispatchStatusButton（#1638）", () => {
  it("申告しているホストが無ければ何も出さない", () => {
    const { container } = render(
      <MobileDispatchStatusButton dispatch={makeDispatch({ hosts: [] })} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("実行中の件数をバッジに出す", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    expect(screen.getByRole("button", { name: "実行状況" })).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("押すとシートに実行キューの中身が出る", () => {
    render(
      <MobileDispatchStatusButton
        dispatch={makeDispatch({ hosts: [makeHost()], jobs: [makeJob()] })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "実行状況" }));

    expect(screen.getByText("実行状況")).toBeTruthy();
    expect(screen.getByText("実行中")).toBeTruthy();
    expect(screen.getByText(/#1638/)).toBeTruthy();
    // このキューが何を映しているかの但し書き（#1567）
    expect(screen.getByText(/GitHub Actionsでの無人実行はここには出ません/)).toBeTruthy();
  });
});
