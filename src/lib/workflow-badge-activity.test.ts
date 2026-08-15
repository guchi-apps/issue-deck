import { describe, expect, it } from "vitest";

import {
  isWorkflowBadgeSpinning,
  SESSION_ACTIVITY_STALE_MS,
  type WorkflowBadgeSession,
} from "@/lib/workflow-badge-activity";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function session(overrides: Partial<WorkflowBadgeSession> = {}): WorkflowBadgeSession {
  return {
    state: "ALIVE",
    activity: null,
    lastReportedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

describe("isWorkflowBadgeSpinning", () => {
  it("GitHub Actionsの実行中は回す", () => {
    expect(
      isWorkflowBadgeSpinning({
        actionsRunning: { isRunning: true },
        approvalPending: false,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("実行状況が未取得・実行が無いときは回さない", () => {
    expect(isWorkflowBadgeSpinning({ approvalPending: false, now: NOW })).toBe(false);
    expect(
      isWorkflowBadgeSpinning({
        actionsRunning: { isRunning: false },
        approvalPending: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("サブPCのセッションが生きていれば回す（#1439）", () => {
    expect(
      isWorkflowBadgeSpinning({ session: session(), approvalPending: false, now: NOW }),
    ).toBe(true);
  });

  it("応答を終えた直後・作業へ戻った直後も回す", () => {
    for (const activity of ["WORKING", "RESPONDED"] as const) {
      expect(
        isWorkflowBadgeSpinning({
          session: session({ activity }),
          approvalPending: false,
          now: NOW,
        }),
      ).toBe(true);
    }
  });

  it("入力待ちのセッションは回さない", () => {
    expect(
      isWorkflowBadgeSpinning({
        session: session({ activity: "WAITING_INPUT" }),
        approvalPending: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("まだ開始していないセッションは回さない（#1465）", () => {
    expect(
      isWorkflowBadgeSpinning({
        session: session({ activity: "NOT_STARTED" }),
        approvalPending: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("終わったセッションは回さない", () => {
    for (const state of ["EXITED", "FAILED", "GONE"] as const) {
      expect(
        isWorkflowBadgeSpinning({
          session: session({ state }),
          approvalPending: false,
          now: NOW,
        }),
      ).toBe(false);
    }
  });

  it("報告が途絶えたセッションは回さない", () => {
    const stale = session({
      lastReportedAt: new Date(NOW - SESSION_ACTIVITY_STALE_MS - 1_000).toISOString(),
    });
    expect(isWorkflowBadgeSpinning({ session: stale, approvalPending: false, now: NOW })).toBe(
      false,
    );
  });

  it("現在時刻が未取得のうちは古さで消さない", () => {
    const stale = session({ lastReportedAt: "2026-08-01T00:00:00.000Z" });
    expect(isWorkflowBadgeSpinning({ session: stale, approvalPending: false, now: null })).toBe(
      true,
    );
  });

  it("承認待ちのときは実行先によらず回さない", () => {
    expect(
      isWorkflowBadgeSpinning({
        actionsRunning: { isRunning: true },
        session: session(),
        approvalPending: true,
        now: NOW,
      }),
    ).toBe(false);
  });
});
