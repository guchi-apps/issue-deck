// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionCloseDialog } from "@/components/dashboard/session-close-dialog";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "yoteiflow-issue-1281",
    repositoryFullName: "guchi-apps/yoteiflow",
    issueNumber: 1281,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    activity: "RESPONDED",
    activityAt: new Date().toISOString(),
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
    firstSeenAt: new Date().toISOString(),
    lastReportedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderDialog(view: DispatchSessionView, onConfirm = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  render(
    <SessionCloseDialog
      session={view}
      open
      onOpenChange={onOpenChange}
      submitting={false}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

afterEach(() => cleanup());

describe("SessionCloseDialog（#4881）", () => {
  it("応答を終えていて変更が無ければ、注意を出さずに終了できる", async () => {
    const { onConfirm, onOpenChange } = renderDialog(session({ worktreeChangeCount: 0 }));

    expect(screen.getByText("このセッションを終了しますか？")).toBeTruthy();
    expect(screen.queryByText(/いま作業中です/)).toBeNull();
    expect(screen.queryByText(/未コミットの変更/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "セッション終了" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("作業中のセッションでは、打ち切ることを知らせてボタンの文言を変える", () => {
    renderDialog(
      session({
        activity: "WORKING",
        step: "TESTING",
        stepAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        stepSeenAt: new Date().toISOString(),
      }),
    );

    expect(screen.getByText("作業中のセッションを終了しますか？")).toBeTruthy();
    expect(screen.getByText(/いま作業中です/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "作業中でも終了する" })).toBeTruthy();
  });

  it("未コミットの変更があれば件数を出す", () => {
    renderDialog(session({ worktreeChangeCount: 4 }));

    expect(screen.getByText("worktreeに未コミットの変更が4件あります")).toBeTruthy();
  });

  it("件数が分からない（古いpoller）ときは注意を出さない", () => {
    renderDialog(session({ worktreeChangeCount: null }));

    expect(screen.queryByText(/未コミットの変更/)).toBeNull();
  });
});
