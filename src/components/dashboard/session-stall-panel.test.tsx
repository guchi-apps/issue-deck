// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStallPanel } from "@/components/dashboard/session-stall-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { describeSessionStall } from "@/lib/dispatch/session-stall";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const INTERRUPTED_AT = "2026-09-07T10:00:00.000Z";

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-2886",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2886,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-09-07T09:00:00.000Z",
    lastReportedAt: "2026-09-07T10:05:00.000Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: "https://claude.ai/code/session_x",
    previewUrl: null,
    answerInApp: false,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    interruptedReason: "api_error",
    interruptedAt: INTERRUPTED_AT,
    models: [],
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [],
    jobs: [],
    sessions: [],
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    sendSessionControl: vi.fn().mockResolvedValue({ ok: true }),
    sendSessionRecovery: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as DispatchStateHandle;
}

afterEach(() => cleanup());

describe("SessionStallPanel", () => {
  it("停滞していなければ何も描かない", () => {
    const { container } = render(
      <SessionStallPanel
        session={makeSession({ interruptedReason: null, interruptedAt: null })}
        dispatch={makeDispatch()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("セッションが見つかっていなければ何も描かない", () => {
    const { container } = render(<SessionStallPanel session={null} dispatch={makeDispatch()} />);
    expect(container.firstChild).toBeNull();
  });

  it("原因ごとの見出しと固定文面のボタンを出す", () => {
    render(<SessionStallPanel session={makeSession()} dispatch={makeDispatch()} />);
    expect(screen.getByText("APIエラーで中断したまま止まっています")).toBeTruthy();
    const preset = describeSessionStall(makeSession())!.presets[0];
    expect(screen.getByRole("button", { name: new RegExp(preset.label) })).toBeTruthy();
  });

  // 押した内容が固定文面のまま届くこと（画面が文面を組み立てないこと）を担保する
  it("固定文面のボタンは、その文面をそのまま復旧の受け口へ送る", async () => {
    const sendSessionRecovery = vi.fn().mockResolvedValue({ ok: true });
    const preset = describeSessionStall(makeSession())!.presets[0];
    render(
      <SessionStallPanel
        session={makeSession()}
        dispatch={makeDispatch({ sendSessionRecovery })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: new RegExp(preset.label) }));

    await waitFor(() => {
      expect(sendSessionRecovery).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2886,
        hostName: "subpc",
        body: preset.body,
      });
    });
  });

  // #2886のG1レビュー: 送出は非同期で見送られることがあるため、押した時点では
  // 「確認待ちが外れた」と言わない（外れるのは`succeeded`の報告を受けたサーバー側）
  it("押した時点では確認待ちが外れたと書かない", async () => {
    const sendSessionRecovery = vi.fn().mockResolvedValue({ ok: true });
    const preset = describeSessionStall(makeSession())!.presets[0];
    render(
      <SessionStallPanel
        session={makeSession()}
        dispatch={makeDispatch({ sendSessionRecovery })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: new RegExp(preset.label) }));

    await waitFor(() => expect(sendSessionRecovery).toHaveBeenCalled());
    expect(screen.getByText(/見送られ、その場合は確認待ちの/)).toBeTruthy();
  });

  // 自由入力は従来の追加指示（#1012）へ流す
  it("自由入力は追加指示として送る", async () => {
    const sendSessionControl = vi.fn().mockResolvedValue({ ok: true });
    render(
      <SessionStallPanel
        session={makeSession()}
        dispatch={makeDispatch({ sendSessionControl })}
      />,
    );

    fireEvent.change(screen.getByLabelText("復旧の指示（自由入力）"), {
      target: { value: "テストだけ流し直してください" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => {
      expect(sendSessionControl).toHaveBeenCalledWith({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2886,
        hostName: "subpc",
        kind: "instruction",
        instruction: "テストだけ流し直してください",
      });
    });
  });

  it("送信に失敗した理由は押した場所に出す", async () => {
    const sendSessionRecovery = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "サブPCが応答していません。" });
    const preset = describeSessionStall(makeSession())!.presets[0];
    render(
      <SessionStallPanel
        session={makeSession()}
        dispatch={makeDispatch({ sendSessionRecovery })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: new RegExp(preset.label) }));

    await waitFor(() => {
      expect(screen.getByText("サブPCが応答していません。")).toBeTruthy();
    });
  });

  it("固定文面で解けない場合の出口としてClaude Codeアプリのリンクを残す", () => {
    render(
      <SessionStallPanel
        session={makeSession({ interruptedReason: "classifier_blocked" })}
        dispatch={makeDispatch()}
      />,
    );
    expect(screen.getByRole("link", { name: /Claude Codeアプリで開く/ })).toBeTruthy();
  });
});
