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
import type { IssuePullRequestProgress } from "@/lib/issue-pull-request-progress";

/**
 * バッジが動く（現在の段のマスを光が掃く。#2516）条件の配線を確認する（#1439）。
 * 条件そのもののケースは`src/lib/workflow-badge-activity.test.ts`にあり、ここでは
 * 「サブPCのセッションが実際にバーへ届いているか」だけを見る。
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
    answerInApp: false,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    models: [],
    ...overrides,
  };
}

/** 実行中の合図（塗ったマスの上をバー全体にわたって掃く光。#2516） */
function liveSweep(container: HTMLElement): Element | null {
  return container.querySelector(".progress-live-sweep");
}

/** 起動中の合図（トラックの上を掃く濃い帯。#2516） */
function barSweep(container: HTMLElement): Element | null {
  return container.querySelector(".progress-bar-sweep");
}

/** 未達のマスを濃く塗っているか（確認待ち・回答待ち。#2516） */
function hasEmphasizedTrack(container: HTMLElement): boolean {
  return container.querySelectorAll('[class*="currentColor_35%"]').length > 0;
}

function pulse(container: HTMLElement): Element | null {
  return container.querySelector(".animate-pulse");
}

/** 濃く塗られた（済んだ）マスの数（#2516・#2867） */
function filledSegments(container: HTMLElement): number {
  return container.querySelectorAll(".bg-current").length;
}

/** 半分の濃さで塗られた「いま」のマス（#2867）。無ければnull */
function currentSegment(container: HTMLElement): string | null {
  return container.querySelector('[data-state="current"]')?.getAttribute("data-segment") ?? null;
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
  it("済んだマスを濃く塗り、いまのマスは半分の濃さにする（9マス。#2867）", () => {
    const planning = render(<WorkflowStepBadge labels={[]} projectStatus="Planning" />);
    expect(filledSegments(planning.container)).toBe(0);
    expect(currentSegment(planning.container)).toBe("planning");
    cleanup();

    // 実装の位置が分からなければ「調査」のマスがいま
    const implementation = render(<WorkflowStepBadge labels={[]} projectStatus="Implementation" />);
    expect(filledSegments(implementation.container)).toBe(1);
    expect(currentSegment(implementation.container)).toBe("exploring");
    cleanup();

    // developへマージ: 計画・調査・実装・検証の4マスが済み、CI・レビューがいま
    const developPr = render(<WorkflowStepBadge labels={[]} projectStatus="Develop PR" />);
    expect(filledSegments(developPr.container)).toBe(4);
    expect(currentSegment(developPr.container)).toBe("pr-checks");
    cleanup();

    // 終端は全部塗る（半分の濃さのマスを残さない）
    const done = render(<WorkflowStepBadge labels={[]} projectStatus="Done" />);
    expect(filledSegments(done.container)).toBe(9);
    expect(currentSegment(done.container)).toBeNull();
  });

  it("実装の中の位置は、サブPCのセッションが報告する作業で決める（#2867）", () => {
    const editing = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        session={session({ step: "EDITING", stepAt: null, stepSeenAt: null })}
        now={NOW}
      />,
    );
    expect(filledSegments(editing.container)).toBe(2);
    expect(currentSegment(editing.container)).toBe("editing");
    cleanup();

    // 入力待ち・終了したセッションでも、最後に報告した作業が到達点
    const testing = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        session={session({ state: "EXITED", step: "TESTING" })}
        now={NOW}
      />,
    );
    expect(filledSegments(testing.container)).toBe(3);
    expect(currentSegment(testing.container)).toBe("verifying");
  });

  it("GitHub Actionsの実装ステップが走っていれば「実装」のマスまで進める（#2867）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        running={{ isRunning: true, currentStep: "Claude Code（実装・PR作成）", runId: 1 }}
      />,
    );
    expect(currentSegment(container)).toBe("editing");
  });

  it("ツールチップに済んだマスの重みの合計を「目安」として添える（#2867）", () => {
    const { container } = render(<WorkflowStepBadge labels={[]} projectStatus="Develop" />);
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("目安 74%");
  });

  // #2516。一覧の行では`00.check-user`・`01.check-*`が下のラベル一覧から除外されるため
  // （`listCardLabels`）、色で伝えるのはこのバッジだけになる。塗ったマスだけでは
  // `Planning`（1/6）の行で5pxしか色が乗らないので、未達のマスも濃く塗る
  it("確認待ち・回答待ちでは未達のマスも濃く塗る", () => {
    const plain = render(<WorkflowStepBadge labels={[]} projectStatus="Planning" />);
    expect(hasEmphasizedTrack(plain.container)).toBe(false);
    cleanup();

    const checkUser = render(
      <WorkflowStepBadge
        labels={[{ name: "00.check-user", color: "", description: null }]}
        projectStatus="Planning"
      />,
    );
    expect(hasEmphasizedTrack(checkUser.container)).toBe(true);
    cleanup();

    const qa = render(<WorkflowStepBadge labels={[]} projectStatus="Planning" qaAnswerPending />);
    expect(hasEmphasizedTrack(qa.container)).toBe(true);
  });

  it("サブPCのセッションが動いている間はバーを掃く", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session()}
        now={NOW}
      />,
    );
    expect(liveSweep(container)).not.toBeNull();
  });

  it("入力待ちで止まっているセッションでは掃かない", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ activity: "WAITING_INPUT" })}
        now={NOW}
      />,
    );
    expect(liveSweep(container)).toBeNull();
    expect(container.textContent).toContain("入力待ち");
  });

  it("GitHub Actionsの実行中は従来どおり掃く", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        running={{ isRunning: true, currentStep: null, runId: 1 }}
        now={NOW}
      />,
    );
    expect(liveSweep(container)).not.toBeNull();
  });

  // #2358。確認待ちのまま処理が動いている間も掃く。判定材料は一覧が持つ
  // `checkUserRunningIssueIds`（#2174）で、渡さなければ従来どおり止まる
  it("確認待ちでもエージェントが動いていれば掃く", () => {
    const labels = [{ name: "00.check-user", color: "", description: null }];
    const props = {
      labels,
      projectStatus: "Implementation" as const,
      executionTarget: { host: "subpc", expectsActionsRun: false },
      session: session(),
      now: NOW,
    };
    const running = render(<WorkflowStepBadge {...props} checkUserRunning />);
    expect(liveSweep(running.container)).not.toBeNull();
    cleanup();
    const stopped = render(<WorkflowStepBadge {...props} />);
    expect(liveSweep(stopped.container)).toBeNull();
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
    expect(liveSweep(container)).not.toBeNull();
  });

  /**
   * #2782。「計画検討中（サブPC・調査中）」が`max-w-[7rem]`（112px）の箱に収まらず、
   * 見たい後半の「調査中」が省略記号で切れていた。セッションの様子が分かるときは、
   * 進捗Status・実行先を省いてそれだけを見せる。
   */
  it("セッションが活動中のときは、進捗Status・実行先を省いて活動と経過時間だけを出す", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Planning"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({
          step: "EXPLORING",
          stepAt: new Date(NOW - 2 * 60_000).toISOString(),
          stepSeenAt: new Date(NOW - 2 * 60_000).toISOString(),
        })}
        now={NOW}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("調査中(2分)");
    expect(stepText).not.toContain("計画検討中");
    expect(stepText).not.toContain("サブPC");
    // 省いた情報はツールチップ（title）にそのまま残す
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "計画検討中（サブPC・調査中(2分)）",
    );
  });

  it("入力待ちも同じ箱に収まる短い表現だけを出す（活動中に限らない。#2782）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Planning"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ activity: "WAITING_INPUT" })}
        now={NOW}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("入力待ち");
    expect(stepText).not.toContain("計画検討中");
  });

  /**
   * #2795。developへPRを作成した後はローカルセッションが終了していてもIssueの対応が
   * 終わったわけではなく、レビュー・統合エージェントによるマージ待ち。「終了」とだけ
   * 出すと対応不要に見えてしまうため、developPR段階では「PR待ち」に言い換える。
   */
  it("developPR段階でセッションが終了していれば「PR待ち」と出す（#2795）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ state: "EXITED" })}
        now={NOW}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("PR待ち");
    expect(container.textContent).not.toContain("終了");
  });

  it("回答を待ったまま終了した場合はdevelopPR段階でも言い換えない（#2795）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ state: "EXITED", activity: "WAITING_INPUT" })}
        now={NOW}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("回答前に終了");
  });

  it("developPR段階以外ではセッションの終了表示を従来どおり「終了」のまま出す（#2795）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({ state: "EXITED" })}
        now={NOW}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("終了");
  });

  it("nowが無い（マウント前）ときも、短い表現のまま出す（経過時間だけ省く）", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Planning"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        session={session({
          step: "EXPLORING",
          stepAt: new Date(NOW - 2 * 60_000).toISOString(),
          stepSeenAt: new Date(NOW - 2 * 60_000).toISOString(),
        })}
      />,
    );
    const stepText = container.querySelector(".truncate")?.textContent;
    expect(stepText).toBe("調査中");
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
 * 実行が始まる前のバッジ（#2449）。**掃くのは起動中だけ**で、順番待ちは明滅にする
 * ——掃くと、実際に作業が進んでいる行と一覧の上で区別が付かなくなる。
 */
describe("QueueStepBadge", () => {
  it("順番待ちは番号を出し、掃かずに明滅させる", () => {
    const { container } = render(<QueueStepBadge queue={queueState()} />);
    expect(container.textContent).toContain("順番待ち 2番目");
    expect(barSweep(container)).toBeNull();
    expect(pulse(container)).not.toBeNull();
    // まだ1段も進んでいないので1マスも塗らない（#2516）
    expect(filledSegments(container)).toBe(0);
  });

  it("起動中は「起動中」を出してトラック全体を掃く", () => {
    const { container } = render(
      <QueueStepBadge queue={queueState({ phase: "starting", position: null })} />,
    );
    expect(container.textContent).toContain("起動中");
    expect(barSweep(container)).not.toBeNull();
    expect(pulse(container)).toBeNull();
    expect(filledSegments(container)).toBe(0);
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
 * 進捗バーが描かれる行ではバーを2つ並べず、添える字で待っていることを言う（#2449）。
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

/**
 * 「developへマージ」段の内訳（#2816）。導出そのもののケースは
 * `src/lib/issue-pull-request-progress.test.ts`にあり、ここでは**画面へ届いているか**だけを見る。
 */
function progress(
  overrides: Partial<IssuePullRequestProgress> = {},
): IssuePullRequestProgress {
  return {
    pullRequestNumber: 2822,
    label: "Claudeがレビュー中",
    tone: "running",
    steps: [
      { key: "opened", label: "実装完了", state: "done" },
      { key: "ci", label: "CI通過", state: "done" },
      { key: "ai-review", label: "Claudeがレビュー中", state: "current" },
      { key: "merge", label: "マージ", state: "pending" },
    ],
    ...overrides,
  };
}

describe("PRを待っている段の内訳（#2816）", () => {
  it("一覧の行は、段の名前ではなく待っているものを添える", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        session={session({ state: "EXITED" })}
        pullRequestProgress={progress()}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("Claudeがレビュー中");
    // セッションが終わっているだけの「PR待ち」には戻さない
    expect(container.textContent).not.toContain("PR待ち");
  });

  it("PRの処理が動いている間は、セッションが終わっていてもバーを掃く", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        session={session({ state: "EXITED" })}
        pullRequestProgress={progress()}
        now={NOW}
      />,
    );
    expect(liveSweep(container)).not.toBeNull();
  });

  it("止まっているPR（CI失敗）は赤に倒し、未達のマスも濃く塗る", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        pullRequestProgress={progress({ label: "CI失敗", tone: "attention" })}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("CI失敗");
    expect(container.querySelectorAll(".text-destructive").length).toBeGreaterThan(0);
    expect(hasEmphasizedTrack(container)).toBe(true);
  });

  it("PRを待っていない段では内訳を読まない", () => {
    const { container } = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Implementation"
        pullRequestProgress={progress()}
        now={NOW}
      />,
    );
    expect(container.textContent).not.toContain("Claudeがレビュー中");
    expect(container.textContent).toContain("実装中");
  });

  it("詳細のステップは、4段の内訳と対応PRの番号を並べる", () => {
    const { container } = render(
      <WorkflowStatusSteps labels={[]} projectStatus="Develop PR" pullRequestProgress={progress()} />,
    );
    expect(container.textContent).toContain("PR #2822");
    for (const label of ["実装完了", "CI通過", "Claudeがレビュー中", "マージ"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("詳細でも、PRを待っていない段では内訳を描かない", () => {
    const { container } = render(
      <WorkflowStatusSteps labels={[]} projectStatus="Develop" pullRequestProgress={progress()} />,
    );
    expect(container.textContent).not.toContain("PR #2822");
  });
});

describe("developへマージの中の位置（#2867）", () => {
  it("CI・レビューが動いている間は「CI・レビュー」のマス、マージだけが残れば「マージ待ち」", () => {
    const reviewing = render(
      <WorkflowStepBadge labels={[]} projectStatus="Develop PR" pullRequestProgress={progress()} />,
    );
    expect(currentSegment(reviewing.container)).toBe("pr-checks");
    cleanup();

    const waiting = render(
      <WorkflowStepBadge
        labels={[]}
        projectStatus="Develop PR"
        pullRequestProgress={progress({
          label: "マージ待ち",
          tone: "waiting",
          steps: [
            { key: "opened", label: "実装完了", state: "done" },
            { key: "ci", label: "CI通過", state: "done" },
            { key: "ai-review", label: "Claudeのレビュー完了", state: "done" },
            { key: "merge", label: "マージ", state: "current" },
          ],
        })}
      />,
    );
    expect(filledSegments(waiting.container)).toBe(5);
    expect(currentSegment(waiting.container)).toBe("pr-merge");
  });

  it("順番待ちのバーは1マスも塗らない（9マスすべてがまだ）", () => {
    const { container } = render(<QueueStepBadge queue={queueState()} />);
    expect(filledSegments(container)).toBe(0);
    expect(container.querySelectorAll("[data-segment]")).toHaveLength(9);
  });
});
