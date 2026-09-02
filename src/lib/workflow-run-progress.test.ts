import { describe, expect, it } from "vitest";

import type { GithubApiWorkflowJob } from "@/lib/github/actions-api";
import {
  extractRunIdFromDetailsUrl,
  jobElapsedMs,
  medianMs,
  resolveJobState,
  summarizeWorkflowRunProgress,
  toCiRunProgress,
  toWorkflowRunJobView,
  type RollupCiCheckLike,
  type WorkflowRunJobView,
  type WorkflowRunProgress,
} from "@/lib/workflow-run-progress";

function job(overrides: Partial<GithubApiWorkflowJob> = {}): GithubApiWorkflowJob {
  return { name: "build", status: "completed", conclusion: "success", steps: [], ...overrides };
}

function jobView(overrides: Partial<WorkflowRunJobView> = {}): WorkflowRunJobView {
  return {
    name: "build",
    state: "success",
    currentStep: null,
    startedAt: null,
    completedAt: null,
    baselineMs: null,
    htmlUrl: null,
    ...overrides,
  };
}

function progress(overrides: Partial<WorkflowRunProgress> = {}): WorkflowRunProgress {
  return {
    runId: 1,
    htmlUrl: null,
    workflowName: "Deploy",
    status: "in_progress",
    conclusion: null,
    startedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    runAttempt: 1,
    jobs: [],
    estimateMs: null,
    ...overrides,
  };
}

describe("resolveJobState", () => {
  it("キュー待ちのジョブは queued", () => {
    expect(resolveJobState(job({ status: "queued", conclusion: null }))).toBe("queued");
    expect(resolveJobState(job({ status: "waiting", conclusion: null }))).toBe("queued");
  });

  it("完了していないジョブは running", () => {
    expect(resolveJobState(job({ status: "in_progress", conclusion: null }))).toBe("running");
  });

  it("完了したジョブは結論で分ける", () => {
    expect(resolveJobState(job({ conclusion: "success" }))).toBe("success");
    expect(resolveJobState(job({ conclusion: "skipped" }))).toBe("skipped");
    expect(resolveJobState(job({ conclusion: "cancelled" }))).toBe("cancelled");
    expect(resolveJobState(job({ conclusion: "failure" }))).toBe("failure");
    // timed_out など知らない結論は失敗側へ倒す（成功と言い切れないものを成功にしない）
    expect(resolveJobState(job({ conclusion: "timed_out" }))).toBe("failure");
  });
});

describe("toWorkflowRunJobView", () => {
  it("実行中のステップ名を現在ステップとして出す", () => {
    const view = toWorkflowRunJobView(
      job({
        status: "in_progress",
        conclusion: null,
        steps: [
          { name: "Checkout code", status: "completed", conclusion: "success" },
          { name: "Build", status: "in_progress", conclusion: null },
        ],
      }),
      new Map(),
    );
    expect(view.state).toBe("running");
    expect(view.currentStep).toBe("Build");
  });

  it("失敗したジョブは、落ちたステップ名を出す", () => {
    const view = toWorkflowRunJobView(
      job({
        conclusion: "failure",
        steps: [
          { name: "Lint", status: "completed", conclusion: "success" },
          { name: "Unit tests", status: "completed", conclusion: "failure" },
        ],
      }),
      new Map(),
    );
    expect(view.currentStep).toBe("Unit tests");
  });

  it("stepsが返らないジョブでも落ちない（キュー待ち）", () => {
    const view = toWorkflowRunJobView(job({ status: "queued", conclusion: null, steps: undefined }), new Map());
    expect(view.state).toBe("queued");
    expect(view.currentStep).toBeNull();
  });

  it("同じ名前のジョブの実績を目安として持つ", () => {
    const view = toWorkflowRunJobView(job({ name: "deploy" }), new Map([["deploy", 130_000]]));
    expect(view.baselineMs).toBe(130_000);
  });
});

describe("jobElapsedMs", () => {
  const start = Date.parse("2026-09-02T00:00:00.000Z");

  it("完了したジョブは所要時間", () => {
    const elapsed = jobElapsedMs(
      jobView({ startedAt: "2026-09-02T00:00:00.000Z", completedAt: "2026-09-02T00:01:30.000Z" }),
      start + 600_000,
    );
    expect(elapsed).toBe(90_000);
  });

  it("実行中のジョブは現在時刻までの経過時間", () => {
    const elapsed = jobElapsedMs(
      jobView({ state: "running", startedAt: "2026-09-02T00:00:00.000Z" }),
      start + 45_000,
    );
    expect(elapsed).toBe(45_000);
  });

  it("キュー待ちのジョブは時間を出さない（started_atが開始前の時刻のため）", () => {
    expect(
      jobElapsedMs(jobView({ state: "queued", startedAt: "2026-09-02T00:00:00.000Z" }), start + 45_000),
    ).toBeNull();
  });
});

describe("medianMs", () => {
  it("実績が3件に満たなければ見込みを出さない", () => {
    expect(medianMs([])).toBeNull();
    expect(medianMs([1_000, 2_000])).toBeNull();
  });

  it("奇数件は中央の値", () => {
    expect(medianMs([3_000, 1_000, 2_000])).toBe(2_000);
  });

  it("偶数件は中央2件の平均", () => {
    expect(medianMs([1_000, 2_000, 3_000, 5_000])).toBe(2_500);
  });

  it("極端に遅い1回に引きずられない", () => {
    expect(medianMs([100_000, 110_000, 105_000, 900_000])).toBe(107_500);
  });
});

describe("summarizeWorkflowRunProgress", () => {
  const start = Date.parse("2026-09-02T00:00:00.000Z");

  it("実行中は経過時間と残り見込みを出す", () => {
    const summary = summarizeWorkflowRunProgress(
      progress({ estimateMs: 400_000 }),
      start + 100_000,
    );
    expect(summary.isRunning).toBe(true);
    expect(summary.elapsedMs).toBe(100_000);
    expect(summary.remainingMs).toBe(300_000);
    expect(summary.overEstimate).toBe(false);
    expect(summary.ratio).toBeCloseTo(0.25);
  });

  it("見込みを超えたら残りを出さず、超過として印を付ける", () => {
    const summary = summarizeWorkflowRunProgress(progress({ estimateMs: 60_000 }), start + 90_000);
    expect(summary.overEstimate).toBe(true);
    expect(summary.remainingMs).toBeNull();
    // 終わっていないことが形で残るよう、バーは端まで行かない
    expect(summary.ratio).toBeLessThan(1);
  });

  it("見込みが無いときは、終わったジョブの割合で代用する", () => {
    const summary = summarizeWorkflowRunProgress(
      progress({
        jobs: [jobView(), jobView({ name: "deploy", state: "running" })],
      }),
      start + 10_000,
    );
    expect(summary.doneJobCount).toBe(1);
    expect(summary.jobCount).toBe(2);
    expect(summary.ratio).toBeCloseTo(0.5);
  });

  it("完了した実行は所要時間を出し、バーを端まで進める", () => {
    const summary = summarizeWorkflowRunProgress(
      progress({
        status: "completed",
        conclusion: "success",
        updatedAt: "2026-09-02T00:05:00.000Z",
      }),
      start + 999_999,
    );
    expect(summary.isRunning).toBe(false);
    expect(summary.elapsedMs).toBe(300_000);
    expect(summary.ratio).toBe(1);
    expect(summary.failed).toBe(false);
  });

  it("失敗した実行は failed になる", () => {
    const summary = summarizeWorkflowRunProgress(
      progress({ status: "completed", conclusion: "failure", updatedAt: "2026-09-02T00:03:00.000Z" }),
      start,
    );
    expect(summary.failed).toBe(true);
  });
});

describe("toCiRunProgress", () => {
  const start = Date.parse("2026-09-02T00:00:00.000Z");

  function check(overrides: Partial<RollupCiCheckLike> = {}): RollupCiCheckLike {
    return {
      name: "lint-and-build",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-09-02T00:00:00.000Z",
      completedAt: "2026-09-02T00:01:00.000Z",
      htmlUrl: "https://github.com/o/r/actions/runs/10/job/1",
      runId: 10,
      ...overrides,
    };
  }

  it("チェックが1件も無ければ内訳を作らない", () => {
    expect(toCiRunProgress([], null, start)).toBeNull();
  });

  it("行はチェック一覧（＝CIバッジと同じ母集団）から作る", () => {
    const result = toCiRunProgress(
      [
        check(),
        check({
          name: "version-tag-check",
          status: "in_progress",
          conclusion: null,
          completedAt: null,
          runId: 20,
          htmlUrl: "https://github.com/o/r/actions/runs/20/job/2",
        }),
      ],
      null,
      start,
    );
    expect(result?.jobs.map((job) => [job.name, job.state])).toEqual([
      ["lint-and-build", "success"],
      ["version-tag-check", "running"],
    ]);
    expect(result?.status).toBe("in_progress");
  });

  it("複数のワークフローにまたがるときは見込みを出さない（1本ぶんでは必ず短く出る）", () => {
    const run = progress({ runId: 10, estimateMs: 300_000 });
    const spanning = toCiRunProgress(
      [check(), check({ name: "version-tag-check", runId: 20 })],
      run,
      start,
    );
    expect(spanning?.estimateMs).toBeNull();

    const single = toCiRunProgress([check(), check({ name: "docs-sync-check" })], run, start);
    expect(single?.estimateMs).toBe(300_000);
  });

  it("実行中のジョブの現在ステップは、取得したrunのジョブから補う", () => {
    const run = progress({
      runId: 10,
      jobs: [
        {
          name: "lint-and-build",
          state: "running",
          currentStep: "Unit tests",
          startedAt: "2026-09-02T00:00:00.000Z",
          completedAt: null,
          baselineMs: 260_000,
          htmlUrl: null,
        },
      ],
    });
    const result = toCiRunProgress(
      [check({ status: "in_progress", conclusion: null, completedAt: null })],
      run,
      start,
    );
    expect(result?.jobs[0].currentStep).toBe("Unit tests");
    expect(result?.jobs[0].baselineMs).toBe(260_000);
  });

  it("失敗したチェックがあれば全体を失敗として扱う", () => {
    const result = toCiRunProgress([check({ conclusion: "failure" })], null, start);
    expect(result?.status).toBe("completed");
    expect(result?.conclusion).toBe("failure");
  });
});

describe("extractRunIdFromDetailsUrl", () => {
  it("実行ログのURLからrun idを取り出す", () => {
    expect(
      extractRunIdFromDetailsUrl("https://github.com/guchi-apps/issue-deck/actions/runs/123456789"),
    ).toBe(123456789);
  });

  it("ジョブまで含むURLからも取り出せる", () => {
    expect(
      extractRunIdFromDetailsUrl(
        "https://github.com/guchi-apps/issue-deck/actions/runs/123/job/456",
      ),
    ).toBe(123);
  });

  it("読めないURLはnull（内訳を出さない側へ倒す）", () => {
    expect(extractRunIdFromDetailsUrl(null)).toBeNull();
    expect(extractRunIdFromDetailsUrl("")).toBeNull();
    expect(extractRunIdFromDetailsUrl("https://circleci.com/build/1")).toBeNull();
    expect(extractRunIdFromDetailsUrl("https://github.com/o/r/actions/runs/abc")).toBeNull();
  });
});
