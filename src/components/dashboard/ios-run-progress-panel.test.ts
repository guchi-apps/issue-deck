import { describe, expect, it } from "vitest";

import { summarizeIosRunProgress } from "@/components/dashboard/ios-run-progress-panel";
import type { IosTestflightRun } from "@/hooks/use-ios-testflight";

function run(overrides: Partial<IosTestflightRun>, states: string[]): IosTestflightRun {
  return {
    id: 1,
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    headSha: "abc1234",
    headBranch: "main",
    event: "workflow_dispatch",
    createdAt: "2026-09-30T14:28:00Z",
    updatedAt: "2026-09-30T14:38:00Z",
    status: "completed",
    conclusion: "success",
    verdict: { kind: "delivered" },
    stages: states.map((state, i) => ({
      key: (["detect", "sign", "build", "upload", "processing", "distribute"] as const)[i],
      label: String(i),
      state: state as never,
      startedAt: null,
      completedAt: null,
    })),
    notes: [],
    ...overrides,
  };
}

describe("summarizeIosRunProgress", () => {
  it("完了した実行は作成から更新までを所要時間にする", () => {
    const s = summarizeIosRunProgress(run({}, ["success", "success", "success", "success", "success", "success"]), 0);
    expect(s).toMatchObject({ total: 6, done: 6, ratio: 1, failed: false, isRunning: false, elapsedMs: 600_000 });
  });

  it("実行中は現在時刻までを経過時間にし、スキップも完了に数える", () => {
    const now = Date.parse("2026-09-30T14:29:12Z");
    const s = summarizeIosRunProgress(
      run({ status: "in_progress", conclusion: null }, ["success", "skipped", "running", "pending", "pending", "pending"]),
      now,
    );
    expect(s).toMatchObject({ done: 2, isRunning: true, elapsedMs: 72_000 });
  });

  it("失敗した段階があればfailedになる", () => {
    expect(summarizeIosRunProgress(run({}, ["success", "failure"]), 0).failed).toBe(true);
  });
});
