// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualStepSessionPanel } from "@/components/dashboard/manual-step-session-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const startManualStepSession = vi.fn();

const issue = {
  repositoryFullName: "guchi-apps/issue-deck",
  number: 2790,
  labels: [{ name: "71.manual-step", color: "ffffff", description: null }],
};

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: null,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: true,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 4,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-2790",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2790,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    models: [],
    firstSeenAt: NOW.toISOString(),
    lastReportedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs: [] as DispatchJobView[],
    sessions: [] as DispatchSessionView[],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    requestCodexPairing: vi.fn(),
    startManualStepSession,
    cancel: vi.fn(),
    ...overrides,
  } as DispatchStateHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
  startManualStepSession.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe("ManualStepSessionPanel（#2771）", () => {
  it("対応したホストがあれば「セッションを起動」を押せ、押すとそのホストへ積む", async () => {
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    const button = screen.getByRole("button", { name: "セッションを起動" });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await waitFor(() => expect(startManualStepSession).toHaveBeenCalledTimes(1));
    expect(startManualStepSession).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2790,
      hostName: "subpc",
    });
  });

  // 古いpollerへ配ると未知の種別として`failed`になり、押した起動が失われる
  it("申告の無いpollerでは押せず、理由を押す前に出す", () => {
    render(
      <ManualStepSessionPanel
        issue={issue}
        dispatch={makeDispatch({ hosts: [makeHost({ manualStepSessionCapable: null })] })}
      />,
    );
    expect(screen.getByRole("button", { name: "セッションを起動" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/pollerが手作業セッションに対応していません/)).toBeTruthy();
  });

  it("手作業Issueでなければ押せない", () => {
    render(
      <ManualStepSessionPanel
        issue={{ ...issue, labels: [] }}
        dispatch={makeDispatch()}
      />,
    );
    expect(screen.getByRole("button", { name: "セッションを起動" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/手作業Issue（`71.manual-step`）ではないため/)).toBeTruthy();
  });

  // 実行の入口を2つ同時に開かない。生きているセッションがあれば、そちらへ誘導する
  it("同じIssueのセッションが動いていれば起動ボタンを出さず、答える先を案内する", () => {
    render(
      <ManualStepSessionPanel
        issue={issue}
        dispatch={makeDispatch({ sessions: [makeSession()] })}
      />,
    );
    expect(screen.queryByRole("button", { name: "セッションを起動" })).toBeNull();
    expect(screen.getByText(/この手作業のセッションが動いています/)).toBeTruthy();
  });

  it("失敗した理由は押した場所の下に出す", async () => {
    startManualStepSession.mockResolvedValue({ ok: false, message: "積めませんでした" });
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッションを起動" }));
    await waitFor(() => expect(screen.getByText("積めませんでした")).toBeTruthy());
  });
});
