import { describe, expect, it } from "vitest";

import {
  describeManualStepRunBadge,
  isFailedManualStepRun,
  sortManualStepRunsForList,
  summarizeManualStepRuns,
  type ManualStepRunView,
} from "@/lib/manual-step-run-view";

function run(overrides: Partial<ManualStepRunView> = {}): ManualStepRunView {
  return {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: "[手作業] サブPC: pollerを再起動する",
    issueId: "issue-1",
    targetHost: "subpc",
    status: "RUNNING",
    pausedReason: null,
    done: 1,
    total: 4,
    currentLine: 10,
    currentLabel: "pnpm install",
    currentJobId: null,
    message: null,
    diagnoseConsent: false,
    startedAt: "2026-08-22T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("summarizeManualStepRuns（#2119）", () => {
  it("件数と進み具合を合計する", () => {
    const summary = summarizeManualStepRuns([
      run({ done: 1, total: 4 }),
      run({ issueNumber: 2, done: 3, total: 6 }),
    ]);

    expect(summary).toMatchObject({ count: 2, done: 4, total: 10, running: true, failed: false });
  });

  // 走っているものが1件も無ければバッジの回転を止める（放っておけば進むように見せない）
  it("全部止まっていればrunningが立たない", () => {
    const summary = summarizeManualStepRuns([
      run({ status: "PAUSED", pausedReason: "USER" }),
      run({ issueNumber: 2, status: "PAUSED", pausedReason: "USER" }),
    ]);

    expect(summary.running).toBe(false);
    expect(summary.failed).toBe(false);
  });

  it("1件でも失敗していればfailedが立つ", () => {
    const summary = summarizeManualStepRuns([
      run(),
      run({ issueNumber: 2, status: "PAUSED", pausedReason: "FAILED" }),
    ]);

    expect(summary.failed).toBe(true);
  });
});

describe("isFailedManualStepRun（#2119）", () => {
  it("人が実行する手順で待っているだけのものは失敗にしない", () => {
    expect(isFailedManualStepRun(run({ status: "PAUSED", pausedReason: "USER" }))).toBe(false);
  });

  it("実行を積めなかったものも失敗として扱う", () => {
    expect(
      isFailedManualStepRun(run({ status: "PAUSED", pausedReason: "ENQUEUE_FAILED" })),
    ).toBe(true);
  });
});

describe("describeManualStepRunBadge（#2119）", () => {
  // 押せるようになっただけの変更で、見慣れた文言まで変えない
  it("1件のときは今までどおり進み具合だけを出す", () => {
    expect(describeManualStepRunBadge(summarizeManualStepRuns([run({ done: 2, total: 5 })]))).toBe(
      "自動実行 2 / 5",
    );
  });

  it("複数走っているときは件数を先に出す", () => {
    const summary = summarizeManualStepRuns([
      run({ done: 2, total: 5 }),
      run({ issueNumber: 2, done: 4, total: 10 }),
    ]);

    expect(describeManualStepRunBadge(summary)).toBe("自動実行 2件 6 / 15");
  });
});

describe("sortManualStepRunsForList（#2119）", () => {
  it("押す必要があるもの（失敗 → あなたが実行 → 実行中）の順に並べる", () => {
    const running = run({ issueNumber: 1 });
    const waiting = run({ issueNumber: 2, status: "PAUSED", pausedReason: "USER" });
    const failed = run({ issueNumber: 3, status: "PAUSED", pausedReason: "FAILED" });

    expect(sortManualStepRunsForList([running, waiting, failed]).map((r) => r.issueNumber)).toEqual(
      [3, 2, 1],
    );
  });

  it("同じ段の中では渡された順（startedAtの新しい順）を保つ", () => {
    const newer = run({ issueNumber: 10 });
    const older = run({ issueNumber: 11 });

    expect(sortManualStepRunsForList([newer, older]).map((r) => r.issueNumber)).toEqual([10, 11]);
  });

  it("渡された配列を書き換えない", () => {
    const runs = [run({ issueNumber: 1 }), run({ issueNumber: 2, status: "PAUSED", pausedReason: "FAILED" })];
    sortManualStepRunsForList(runs);

    expect(runs.map((r) => r.issueNumber)).toEqual([1, 2]);
  });
});
