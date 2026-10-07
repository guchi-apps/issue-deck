// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDetail } from "@/components/dashboard/session-detail";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const sendSessionControl = vi.fn();

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-3991",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 3991,
    issueTitle: "セッション詳細画面のUIリデザイン",
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
    firstSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastReportedAt: new Date().toISOString(),
    ...overrides,
  };
}

function dispatchHandle(): DispatchStateHandle {
  const host = {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: new Date().toISOString(),
    sessionControlCapable: true,
    instructionCapable: true,
  } as DispatchHostView;
  return {
    hosts: [host],
    jobs: [] as DispatchJobView[],
    sessions: [],
    isSubmitting: false,
    sendSessionControl,
  } as unknown as DispatchStateHandle;
}

beforeEach(() => {
  sendSessionControl.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SessionDetail（#3991）", () => {
  it("押すとモーダルが開き、日本語の詳細情報と操作が並ぶ", () => {
    render(<SessionDetail session={session({ models: [] })} dispatch={dispatchHandle()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッション詳細" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("セッションの情報")).toBeTruthy();
    expect(screen.getByText("issue-deck-issue-3991")).toBeTruthy();
    expect(screen.getByRole("button", { name: "作業を止める" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "セッションを終了" })).toBeTruthy();
  });

  it("書いた追加指示をそのセッションのホストへ送る", async () => {
    render(<SessionDetail session={session()} dispatch={dispatchHandle()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッション詳細" }));
    fireEvent.change(screen.getByLabelText("追加指示の本文"), { target: { value: "続けてください" } });
    fireEvent.click(screen.getByRole("button", { name: "指示を送る" }));

    await waitFor(() =>
      expect(sendSessionControl).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "instruction", instruction: "続けてください", hostName: "subpc" }),
      ),
    );
  });

  it("消えたセッションには操作を出さない", () => {
    render(<SessionDetail session={session({ state: "GONE" })} dispatch={dispatchHandle()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッション詳細" }));

    expect(screen.queryByRole("button", { name: "作業を止める" })).toBeNull();
    expect(screen.queryByRole("button", { name: "セッションを終了" })).toBeNull();
  });

  it("作業ログのステップコードを日本語で出す（#4124）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          events: [
            { id: "1", occurredAt: new Date().toISOString(), kind: "step", title: "作業: EXPLORING", body: null },
            { id: "2", occurredAt: new Date().toISOString(), kind: "step", title: "作業: RUNNING", body: null },
          ],
        }),
      }),
    );
    render(<SessionDetail session={session({ id: "session-1" })} dispatch={dispatchHandle()} />);
    fireEvent.click(screen.getByRole("button", { name: "セッション詳細" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("調査中— ファイル・コード・履歴を読んで調べています"));
    expect(dialog.textContent).toContain("コマンド実行中");
    expect(dialog.textContent).not.toMatch(/EXPLORING|RUNNING/);
  });
});
