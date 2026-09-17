// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBulkControlPanel } from "@/components/dashboard/agent-bulk-control-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-17T00:00:00Z",
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    manualStepVpsCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
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
    tmuxSessionName: "issue-deck-issue-2994",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2994,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-09-17T00:00:00Z",
    lastReportedAt: "2026-09-17T00:00:00Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    answerInApp: false,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    interruptedReason: null,
    interruptedAt: null,
    waitingTool: null,
    waitingTarget: null,
    models: [],
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs: [],
    sessions: [],
    agentPause: { claude: null, codex: null },
    isSubmitting: false,
    setAgentDispatchPaused: vi.fn().mockResolvedValue({ ok: true }),
    sendSessionControl: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as DispatchStateHandle;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentBulkControlPanel", () => {
  it("申告しているサブPCが無ければ何も出さない", () => {
    const { container } = render(<AgentBulkControlPanel dispatch={makeDispatch({ hosts: [] })} />);
    expect(container.firstChild).toBeNull();
  });

  it("動いているセッションがあれば「実行中」チップを出す", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ sessions: [makeSession({ codexThreadKnown: null })] })}
      />,
    );
    expect(screen.getAllByText("実行中")).toHaveLength(1);
  });

  it("自動検知で一時停止中なら理由付きのチップを出す", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ agentPause: { claude: "usage_limit", codex: null } })}
      />,
    );
    expect(screen.getByText("停止中（自動）")).not.toBeNull();
  });

  it("手動で一時停止中なら理由付きのチップを出す", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ agentPause: { claude: null, codex: "manual" } })}
      />,
    );
    expect(screen.getByText("停止中（手動）")).not.toBeNull();
  });

  it("稼働中にトグルを押すと確認ダイアログが出て、確定すると一時停止と対象セッションへの中断を送る", async () => {
    const sendSessionControl = vi.fn().mockResolvedValue({ ok: true });
    const setAgentDispatchPaused = vi.fn().mockResolvedValue({ ok: true });
    const session = makeSession({ codexThreadKnown: null });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ sessions: [session], sendSessionControl, setAgentDispatchPaused })}
      />,
    );

    const toggles = screen.getAllByRole("switch");
    fireEvent.click(toggles[0]);

    const confirmButton = await screen.findByRole("button", { name: "停止する" });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(setAgentDispatchPaused).toHaveBeenCalledWith({ agent: "claude", paused: true });
      expect(sendSessionControl).toHaveBeenCalledWith({
        repositoryFullName: session.repositoryFullName,
        issueNumber: session.issueNumber,
        hostName: session.host,
        kind: "interrupt",
      });
    });
  });

  it("停止中にトグルを押すと、確認無しでそのまま再開する", async () => {
    const setAgentDispatchPaused = vi.fn().mockResolvedValue({ ok: true });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          agentPause: { claude: "manual", codex: null },
          setAgentDispatchPaused,
        })}
      />,
    );

    const toggles = screen.getAllByRole("switch");
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      expect(setAgentDispatchPaused).toHaveBeenCalledWith({ agent: "claude", paused: false });
    });
    expect(screen.queryByRole("button", { name: "停止する" })).toBeNull();
  });
});
