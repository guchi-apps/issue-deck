// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * バッジの外周リング（`animate-spin`）が回る条件の配線を確認する（#1439）。
 * 条件そのもののケースは`src/lib/workflow-badge-activity.test.ts`にあり、ここでは
 * 「サブPCのセッションが実際にリングへ届いているか」だけを見る。
 */

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1439",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1439,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T11:00:00.000Z",
    lastReportedAt: new Date(NOW - 10_000).toISOString(),
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    ...overrides,
  };
}

function spinner(container: HTMLElement): Element | null {
  return container.querySelector(".animate-spin");
}

afterEach(cleanup);

describe("WorkflowStepBadge", () => {
  it("サブPCのセッションが動いている間はリングを回す", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session()}
        now={NOW}
      />,
    );
    expect(spinner(container)).not.toBeNull();
  });

  it("入力待ちで止まっているセッションでは回さない", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ activity: "WAITING_INPUT" })}
        now={NOW}
      />,
    );
    expect(spinner(container)).toBeNull();
    expect(container.textContent).toContain("入力待ち");
  });

  it("GitHub Actionsの実行中は従来どおり回す", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        running={{ isRunning: true, currentStep: null, runId: 1 }}
        now={NOW}
      />,
    );
    expect(spinner(container)).not.toBeNull();
  });

  it("サブPC実行では「起動待ち」を出さない（#1262の判定を壊していない）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        running={{ isRunning: false, currentStep: null, runId: null }}
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session()}
        now={NOW}
      />,
    );
    expect(container.textContent).not.toContain("起動待ち");
    expect(spinner(container)).not.toBeNull();
  });
});
