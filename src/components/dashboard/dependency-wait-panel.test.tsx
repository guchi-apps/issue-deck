// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DependencyWaitPanel } from "@/components/dashboard/dependency-wait-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DependencyWaitView } from "@/lib/dispatch/dependency-wait";

function makeWait(overrides: Partial<DependencyWaitView> = {}): DependencyWaitView {
  return {
    id: "wait-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    dependency: { repository: "guchi-apps/issue-deck", number: 2, kind: "issue" },
    dependencyUrl: "https://github.com/guchi-apps/issue-deck/issues/2",
    conditions: ["closed"],
    reason: "テスト",
    status: "WAITING",
    source: "session",
    results: [],
    lastCheckedAt: null,
    lastError: null,
    failureReason: null,
    resumeRequestedAt: null,
    resumeSentAt: null,
    resumedAt: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe("DependencyWaitPanel の待機解除", () => {
  it("確認後に cancel を送る", async () => {
    const controlDependencyWait = vi.fn().mockResolvedValue({ ok: true, wait: makeWait({ status: "CANCELLED" }) });
    const dispatch = { isSubmitting: false, controlDependencyWait } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={makeWait()} dispatch={dispatch} />);

    fireEvent.click(screen.getByRole("button", { name: "待機を解除" }));
    expect(controlDependencyWait).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "解除する" }));

    await waitFor(() =>
      expect(controlDependencyWait).toHaveBeenCalledWith({ id: "wait-1", action: "cancel" }),
    );
  });

  it("解除済みの待機には解除ボタンを出さない", () => {
    const dispatch = { isSubmitting: false, controlDependencyWait: vi.fn() } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={makeWait({ status: "CANCELLED" })} dispatch={dispatch} />);
    expect(screen.queryByRole("button", { name: "待機を解除" })).toBeNull();
  });
});

describe("DependencyWaitPanel の自動再試行の表示（#5005）", () => {
  it("未送信入力で見送られた待ちは、理由を目立たせて次の再試行時刻を出す", () => {
    const dispatch = { isSubmitting: false, controlDependencyWait: vi.fn(), hosts: [], sessions: [] } as unknown as DispatchStateHandle;
    render(
      <DependencyWaitPanel
        wait={makeWait({
          status: "RESUME_FAILED",
          failureReason: "再開の指示は見送られました: 入力欄に未送信の文字が残っています",
          autoRetryCount: 1,
          nextAutoRetryAt: "2026-10-10T12:07:00Z",
        })}
        dispatch={dispatch}
      />,
    );
    expect(screen.getByTestId("dependency-wait-unsent-input")).toBeTruthy();
    expect(screen.getByText(/次の自動再試行/)).toBeTruthy();
    expect(screen.getByText(/残り2回/)).toBeTruthy();
  });
});

describe("DependencyWaitPanel の未送信入力の退避（#4383）", () => {
  const session = {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    host: "subpc",
    state: "ALIVE",
    codexThreadKnown: null,
    tmuxSessionName: "issue-deck-issue-1",
  };
  const failed = makeWait({
    status: "RESUME_FAILED",
    failureReason: "再開の指示は見送られました: 入力欄に未送信の文字が残っています",
  });

  it("確認画面で対象と今回の指示を見せ、確認後だけ stashInput 付きで再開する", async () => {
    const controlDependencyWait = vi.fn().mockResolvedValue({ ok: true, wait: failed });
    const dispatch = { isSubmitting: false, controlDependencyWait, hosts: [{ name: "subpc", online: true, instructionCapable: true, stashInputCapable: true }], sessions: [session] } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={failed} dispatch={dispatch} />);

    fireEvent.click(screen.getByRole("button", { name: "未送信の入力を退避して、再開指示を送信" }));
    const dialog = await screen.findByTestId("stash-confirm-dialog");
    expect(dialog.textContent).toContain("subpc");
    expect(dialog.textContent).toContain("issue-deck-issue-1");
    expect(dialog.textContent).toContain("退避");
    expect(controlDependencyWait).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "退避して送信" }));
    await waitFor(() =>
      expect(controlDependencyWait).toHaveBeenCalledWith({ id: "wait-1", action: "resume", stashInput: true }),
    );
  });

  it("旧pollerでは退避操作を無効にし更新を案内する", () => {
    const controlDependencyWait = vi.fn();
    const dispatch = { isSubmitting: false, controlDependencyWait, sessions: [session], hosts: [{ name: "subpc", online: true, instructionCapable: true }] } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={failed} dispatch={dispatch} />);
    expect((screen.getByRole("button", { name: "未送信の入力を退避して、再開指示を送信" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/更新して再起動/)).not.toBeNull();
    expect(controlDependencyWait).not.toHaveBeenCalled();
  });

  it("キャンセルでは何も送らない", async () => {
    const controlDependencyWait = vi.fn();
    const dispatch = { isSubmitting: false, controlDependencyWait, hosts: [{ name: "subpc", online: true, instructionCapable: true, stashInputCapable: true }], sessions: [session] } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={failed} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("button", { name: "未送信の入力を退避して、再開指示を送信" }));
    fireEvent.click(await screen.findByRole("button", { name: "キャンセル" }));
    expect(controlDependencyWait).not.toHaveBeenCalled();
  });

  it("承認待ち・作業中の見送りでは退避ボタンを出さない", () => {
    const blocked = makeWait({
      status: "RESUME_FAILED",
      failureReason: "再開の指示は見送られました: 承認プロンプトまたは選択フォームの表示中です",
    });
    const dispatch = { isSubmitting: false, controlDependencyWait: vi.fn(), hosts: [{ name: "subpc", online: true, instructionCapable: true, stashInputCapable: true }], sessions: [session] } as unknown as DispatchStateHandle;
    render(<DependencyWaitPanel wait={blocked} dispatch={dispatch} />);
    expect(screen.queryByRole("button", { name: "未送信の入力を退避して、再開指示を送信" })).toBeNull();
  });
});
