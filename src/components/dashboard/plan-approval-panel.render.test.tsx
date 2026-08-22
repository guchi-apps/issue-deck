// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanApprovalPanel } from "@/components/dashboard/plan-approval-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

function request(overrides: Partial<SessionPlanRequestView> = {}): SessionPlanRequestView {
  return {
    id: "req-1",
    repositoryFullName: REPO,
    issueNumber: 2061,
    hostName: "subpc",
    plan: "## 要約\n\n**計画の承認パネルをIssue詳細に出す**",
    status: "WAITING",
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 27 * 60 * 1000).toISOString(),
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    id: "session-1",
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-2061",
    repositoryFullName: REPO,
    issueNumber: 2061,
    state: "ALIVE",
    activity: "WAITING_INPUT",
    ...overrides,
  } as DispatchSessionView;
}

function dispatchHandle(decidePlan = vi.fn().mockResolvedValue({ ok: true })) {
  return { decidePlan, isSubmitting: false } as unknown as DispatchStateHandle;
}

describe("PlanApprovalPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("計画の中身と、承認・修正・端末で答えるの3つを出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("計画の承認を待っています")).toBeTruthy();
    expect(screen.getByText("計画の承認パネルをIssue詳細に出す")).toBeTruthy();
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /修正を送る/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /端末・Remote Controlで答える/ })).toBeTruthy();
  });

  it("承認を押すと`approve`を送り、押した結果をその場に出す", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /承認して実装へ進む/ }));

    await waitFor(() => {
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "approve",
        text: undefined,
      });
    });
    await waitFor(() => expect(screen.getByText("承認を送りました。")).toBeTruthy());
  });

  /** `deny`の理由がそのまま次の指示になるので、本文が空のまま送れてはいけない */
  it("修正は本文を書くまで送れない", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /修正を送る/ }));
    const send = screen.getByRole("button", { name: /修正を送る/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("修正してほしいこと"), {
      target: { value: "待ち時間を短くしてください。" },
    });
    expect((screen.getByRole("button", { name: /修正を送る/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("押した結果は、押していなくてもサーバー側の状態から出す（他の端末で押された場合）", () => {
    render(
      <PlanApprovalPanel
        request={request({ status: "REVISION_REQUESTED", decidedAt: new Date().toISOString() })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("修正を送りました。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /承認して実装へ進む/ })).toBeNull();
  });

  it("待ち時間が切れたら、端末で答えるよう案内する", () => {
    render(
      <PlanApprovalPanel
        request={request({ status: "EXPIRED" })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("端末に承認プロンプトを出しました。")).toBeTruthy();
  });

  /** 終了したセッションへ押しても届かない。**ボタンは消さずに理由を出す** */
  it("セッションが終了していたら、押せない理由を出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session({ state: "EXITED" })}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/このセッションは終了しています/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /承認して実装へ進む/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
