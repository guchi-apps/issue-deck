// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  QueueStepBadge,
  WorkflowStatusSteps,
  WorkflowStepBadge,
} from "@/components/dashboard/workflow-status-steps";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { IssueQueueState } from "@/lib/dispatch/issue-queue-state";
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
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T11:00:00.000Z",
    lastReportedAt: new Date(NOW - 10_000).toISOString(),
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    ...overrides,
  };
}

function spinner(container: HTMLElement): Element | null {
  return container.querySelector(".animate-spin");
}

function pulse(container: HTMLElement): Element | null {
  return container.querySelector(".animate-pulse");
}

function queueState(overrides: Partial<IssueQueueState> = {}): IssueQueueState {
  return {
    phase: "queued",
    position: 2,
    queuedTotal: 3,
    job: { status: "QUEUED" } as DispatchJobView,
    ...overrides,
  };
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

  // #2358。確認待ちのまま処理が動いている間も回す。判定材料は一覧が持つ
  // `checkUserRunningIssueIds`（#2174）で、渡さなければ従来どおり止まる
  it("確認待ちでもエージェントが動いていれば回す", () => {
    const labels = [{ name: "00.check-user", color: "", description: null }];
    const props = {
      labels,
      projectStatus: "Implementation" as const,
      executionTarget: { host: "subpc", expectsActionsRun: false },
      session: session(),
      now: NOW,
    };
    const running = render(<WorkflowStepBadge {...props} checkUserRunning />);
    expect(spinner(running.container)).not.toBeNull();
    cleanup();
    const stopped = render(<WorkflowStepBadge {...props} />);
    expect(spinner(stopped.container)).toBeNull();
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

/**
 * #1676。確認待ちのバッジを現在ステップの行へ流し込んでいたため、折り返したときに行間ぶんしか
 * 空かず、丸みのあるバッジが上の行に貼り付いて見えていた。**段を分けて隙間を持たせる。**
 */
describe("WorkflowStatusSteps のスマホ用キャプション", () => {
  it("確認待ちのバッジは現在ステップの段と分ける", () => {
    const { container } = render(
      <WorkflowStatusSteps
        labels={[{ name: "00.check-user", color: "", description: null }]}
        projectStatus="Planning"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
      />,
    );

    const badge = container.querySelector(".md\\:hidden .rounded-full");
    expect(badge?.textContent).toContain("ユーザー確認待ち");
    // 同じ`<p>`の中に流し込まない（親が段組みで、隙間は`gap`が持つ）
    expect(badge?.closest("p")).toBeNull();
    expect(badge?.parentElement?.className).toContain("gap-1.5");
  });
});

/**
 * 実行が始まる前のバッジ（#2449）。**回すのは起動中だけ**で、順番待ちは破線の明滅にする
 * ——回すと、実際に作業が進んでいる行と一覧の上で区別が付かなくなる。
 */
describe("QueueStepBadge", () => {
  it("順番待ちは番号を出し、回さずに明滅させる", () => {
    const { container } = render(<QueueStepBadge queue={queueState()} />);
    expect(container.textContent).toContain("順番待ち 2番目");
    expect(spinner(container)).toBeNull();
    expect(pulse(container)).not.toBeNull();
  });

  it("起動中は「起動中」を出して回す", () => {
    const { container } = render(
      <QueueStepBadge queue={queueState({ phase: "starting", position: null })} />,
    );
    expect(container.textContent).toContain("起動中");
    expect(spinner(container)).not.toBeNull();
  });

  it("待ちが進まない理由はツールチップに出す", () => {
    const { container } = render(
      <QueueStepBadge queue={queueState()} waitReason="サブPCのセッションが上限です" />,
    );
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "サブPCのセッションが上限です",
    );
  });
});

/**
 * 進捗の円グラフが描かれる行では円を2つ並べず、添える字で待っていることを言う（#2449）。
 */
describe("WorkflowStepBadgeの順番待ち", () => {
  it("実行先と順番待ちを両方添える", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        queue={queueState()}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("サブPC・順番待ち 2番目");
  });

  it("順番待ちはセッションの様子より優先する（前回の残骸を出さない）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ state: "EXITED" })}
        queue={queueState({ phase: "starting", position: null })}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("起動中");
    expect(container.textContent).not.toContain("終了");
  });
});
