// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBulkControlPanel } from "@/components/dashboard/agent-bulk-control-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { AGENT_RESUME_INSTRUCTION } from "@/lib/dispatch/agent-resume";
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
    resumeAgentSessions: vi.fn().mockResolvedValue({ ok: true, resumed: 0, failed: [] }),
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

  it("Codex CLIの実行中表示の右隣に接続ボタンを出す", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          hosts: [makeHost({ codexRemoteControlCapable: true })],
          sessions: [makeSession({ codexThreadKnown: false })],
          requestCodexPairing: vi.fn().mockResolvedValue({ ok: true }),
        })}
      />,
    );

    const codexName = screen.getByText("Codex CLI");
    const row = codexName.closest("div.flex.flex-col.gap-1\\.5");
    expect(row?.textContent).toMatch(/Codex CLI.*実行中.*接続/);
  });

  it("接続ボタンから対応ホストへペアリング発行を依頼する", async () => {
    const requestCodexPairing = vi.fn().mockResolvedValue({ ok: true });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          hosts: [makeHost({ codexRemoteControlCapable: true })],
          requestCodexPairing,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(requestCodexPairing).toHaveBeenCalledWith("subpc"));
  });

  it("発行済みのペアリングコードはCodex CLI行の下に表示する", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          hosts: [makeHost({ codexRemoteControlCapable: true })],
          jobs: [
            {
              id: "pairing",
              kind: "CODEX_PAIRING",
              status: "SUCCEEDED",
              targetHost: "subpc",
              codexPairingCode: "A1B2-C3D4",
              codexPairingExpiresAt: new Date(Date.now() + 540_000).toISOString(),
            },
          ] as unknown as DispatchStateHandle["jobs"],
          requestCodexPairing: vi.fn().mockResolvedValue({ ok: true }),
        })}
      />,
    );

    expect(screen.getByText("A1B2-C3D4")).not.toBeNull();
  });

  it("対応ホストが無ければ接続ボタンを出さない", () => {
    render(<AgentBulkControlPanel dispatch={makeDispatch()} />);

    expect(screen.queryByRole("button", { name: "接続" })).toBeNull();
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

  it("稼働中は「停止」ボタン、停止中は「再開」ボタンを出す", () => {
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ agentPause: { claude: null, codex: "manual" } })}
      />,
    );
    expect(screen.getByRole("button", { name: "Claude Codeを停止" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Claude Codeを再開" })).toBeNull();
    expect(screen.getByRole("button", { name: "Codex CLIを再開" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Codex CLIを停止" })).toBeNull();
  });

  it("「停止」ボタンも確認ダイアログを経て、一時停止と対象セッションへの中断を送る", async () => {
    const sendSessionControl = vi.fn().mockResolvedValue({ ok: true });
    const setAgentDispatchPaused = vi.fn().mockResolvedValue({ ok: true });
    const session = makeSession({ codexThreadKnown: null });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({ sessions: [session], sendSessionControl, setAgentDispatchPaused })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude Codeを停止" }));
    expect(setAgentDispatchPaused).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "停止する" }));

    await waitFor(() => {
      expect(setAgentDispatchPaused).toHaveBeenCalledWith({ agent: "claude", paused: true });
      expect(sendSessionControl).toHaveBeenCalledTimes(1);
    });
  });

  it("「再開」ボタンは確認ダイアログを経てから再開を送る（確認前は何も送らない）", async () => {
    const resumeAgentSessions = vi.fn().mockResolvedValue({ ok: true, resumed: 1, failed: [] });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          agentPause: { claude: "manual", codex: null },
          resumeAgentSessions,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude Codeを再開" }));
    expect(resumeAgentSessions).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "再開する" }));

    await waitFor(() => {
      expect(resumeAgentSessions).toHaveBeenCalledWith({ agent: "claude" });
    });
  });

  it("停止したセッションが分かるときは、再開ダイアログに対象を出す", async () => {
    const session = makeSession({
      codexThreadKnown: null,
      activity: "RESPONDED",
      activityAt: "2026-09-17T00:00:00Z",
      stepSeenAt: "2026-09-17T00:30:00Z",
    });
    const interrupt = {
      id: "job-1",
      kind: "INTERRUPT",
      status: "SUCCEEDED",
      targetHost: session.host,
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      finishedAt: "2026-09-17T01:00:00Z",
    };
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          agentPause: { claude: "manual", codex: null },
          sessions: [session],
          jobs: [interrupt] as unknown as DispatchStateHandle["jobs"],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude Codeを再開" }));
    expect(await screen.findByText("再開の対象（1件）")).not.toBeNull();
    // 押す前に、送る固定の1行の全文が出ている
    expect(screen.getByText(AGENT_RESUME_INSTRUCTION)).not.toBeNull();
  });

  it("再開に失敗した理由は押した場所に出す", async () => {
    const resumeAgentSessions = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "サブPCがオフラインです" });
    render(
      <AgentBulkControlPanel
        dispatch={makeDispatch({
          agentPause: { claude: "manual", codex: null },
          resumeAgentSessions,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude Codeを再開" }));
    fireEvent.click(await screen.findByRole("button", { name: "再開する" }));

    expect(await screen.findByText("サブPCがオフラインです")).not.toBeNull();
  });
});
