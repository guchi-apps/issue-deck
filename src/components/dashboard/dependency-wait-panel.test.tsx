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
