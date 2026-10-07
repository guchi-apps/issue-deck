// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualStepSessionPanel } from "@/components/dashboard/manual-step-session-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const startManualStepSession = vi.fn();
const copyText = vi.fn(async (text: string) => {
  void text;
  return true;
});

vi.mock("@/lib/copy-text", () => ({ copyText: (text: string) => copyText(text) }));

/** テンプレートどおりの本文（サブPCの手順1件・ブラウザの手順1件・完了の確認1件） */
const BODY = `## 前提条件

- 実行するデバイス: **サブPC**
- カレントディレクトリ: \`~/apps/issue-deck\`

## やること

- [ ] pollerを再起動する

    \`\`\`bash
    systemctl --user restart issue-deck-dispatch-poller.service
    \`\`\`

- [ ] （ブラウザ）1Passwordで\`apps\`ボールトの値を登録する

    \`\`\`bash
    open https://1password.com && echo registered
    \`\`\`

## 完了の確認方法

- 動いていること

    \`\`\`bash
    systemctl --user is-active issue-deck-dispatch-poller.service
    \`\`\`
`;

const issue = {
  repositoryFullName: "guchi-apps/issue-deck",
  number: 2790,
  labels: [{ name: "71.manual-step", color: "ffffff", description: null }],
  body: BODY,
};

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    manualStepVpsCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: true,
    chatCodexCapable: null,
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
  copyText.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

const START_BUTTON = "セッションを起動して実行を開始";

describe("ManualStepSessionPanel（#2771）", () => {
  it("対応したホストがあれば「セッションを起動」を押せ、押すとそのホストへ積む", async () => {
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    const button = screen.getByRole("button", { name: START_BUTTON });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await waitFor(() => expect(startManualStepSession).toHaveBeenCalledTimes(1));
    expect(startManualStepSession).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2790,
      hostName: "subpc",
      agent: "claude",
      model: "sonnet",
    });
  });

  it("選んだモデルを手作業セッションの起動要求へ渡す", async () => {
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Opus 5.5/, checked: false }));
    fireEvent.click(screen.getByRole("button", { name: START_BUTTON }));

    await waitFor(() =>
      expect(startManualStepSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: "opus" }),
      ),
    );
  });

  it("Codexとそのモデルを選んで手作業セッションの起動要求へ渡す", async () => {
    render(
      <ManualStepSessionPanel
        issue={issue}
        dispatch={makeDispatch({ hosts: [makeHost({ codexCapable: true })] })}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));
    fireEvent.click(screen.getByRole("radio", { name: /GPT-6 Sol/, checked: false }));
    fireEvent.click(screen.getByRole("button", { name: START_BUTTON }));

    await waitFor(() =>
      expect(startManualStepSession).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "codex", model: "gpt-6-sol" }),
      ),
    );
    expect(screen.getByText(/Remote Controlのリンクは出ません/)).toBeTruthy();
  });

  // 古いpollerへ配ると未知の種別として`failed`になり、押した起動が失われる
  it("申告の無いpollerでは押せず、理由を押す前に出す", () => {
    render(
      <ManualStepSessionPanel
        issue={issue}
        dispatch={makeDispatch({ hosts: [makeHost({ manualStepSessionCapable: null })] })}
      />,
    );
    expect(screen.getByRole("button", { name: START_BUTTON })).toHaveProperty("disabled", true);
    expect(screen.getByText(/pollerが手作業セッションに対応していません/)).toBeTruthy();
  });

  it("手作業Issueでなければ押せない", () => {
    render(
      <ManualStepSessionPanel
        issue={{ ...issue, labels: [] }}
        dispatch={makeDispatch()}
      />,
    );
    expect(screen.getByRole("button", { name: START_BUTTON })).toHaveProperty(
      "disabled",
      true,
    );
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
    expect(screen.queryByRole("button", { name: START_BUTTON })).toBeNull();
    expect(screen.getByText(/この手作業のセッションが動いています/)).toBeTruthy();
  });

  it("本文から読み取れた既知の手順と、自律実行の方針を起動前に示す", () => {
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    expect(screen.getByText("本文から実行可能 2件")).toBeTruthy();
    expect(screen.getAllByText("本人操作が必要そう 1件")).toHaveLength(2);
    expect(screen.getByText(/本文に無い調査・修正・確認も自動で行います/)).toBeTruthy();
    expect(
      screen.getByText("systemctl --user restart issue-deck-dispatch-poller.service"),
    ).toBeTruthy();
    expect(screen.getByText("ブラウザ")).toBeTruthy();
    // 代行しない理由は手作業アシスタントと同じ文言で出す
    expect(screen.getByText(/ブラウザで実行するため/)).toBeTruthy();
  });

  it("人が実行するコマンドをまとめて、または1行ずつコピーできる", async () => {
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);

    fireEvent.click(screen.getByRole("button", { name: "2行をまとめてコピー" }));
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith("open https://1password.com\necho registered"),
    );
    expect(screen.getByRole("button", { name: "コピーしました" })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "コピー" })[0]);
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith("open https://1password.com"));
  });

  it("失敗した理由は押した場所の下に出す", async () => {
    startManualStepSession.mockResolvedValue({ ok: false, message: "積めませんでした" });
    render(<ManualStepSessionPanel issue={issue} dispatch={makeDispatch()} />);
    fireEvent.click(screen.getByRole("button", { name: START_BUTTON }));
    await waitFor(() => expect(screen.getByText("積めませんでした")).toBeTruthy());
  });
});
