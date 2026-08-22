import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchOpenPullRequests = vi.fn();
const fetchPullRequestCiStates = vi.fn();
const fetchRepairWorkflowAvailability = vi.fn();
const fetchCheckUserIssueReasons = vi.fn();
const fetchLatestConflictRepairRuns = vi.fn();
const recordPullRequestRepairRun = vi.fn();
const settleResolvedConflictRepairRuns = vi.fn();
const dispatchWorkflow = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return findMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/pull-requests-api", () => ({
  get fetchOpenPullRequests() {
    return fetchOpenPullRequests;
  },
}));

vi.mock("@/lib/github/release-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/release-api")>();
  return {
    ...actual,
    get fetchPullRequestCiStates() {
      return fetchPullRequestCiStates;
    },
  };
});

vi.mock("@/lib/github/repair-workflow-cache", () => ({
  get fetchRepairWorkflowAvailability() {
    return fetchRepairWorkflowAvailability;
  },
}));

vi.mock("@/lib/pull-request-check-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pull-request-check-user")>();
  return {
    ...actual,
    get fetchCheckUserIssueReasons() {
      return fetchCheckUserIssueReasons;
    },
  };
});

vi.mock("@/lib/github/pull-request-repair-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/pull-request-repair-run")>();
  return {
    ...actual,
    get fetchLatestConflictRepairRuns() {
      return fetchLatestConflictRepairRuns;
    },
    get recordPullRequestRepairRun() {
      return recordPullRequestRepairRun;
    },
    get settleResolvedConflictRepairRuns() {
      return settleResolvedConflictRepairRuns;
    },
  };
});

vi.mock("@/lib/github/workflow-dispatch", () => ({
  get dispatchWorkflow() {
    return dispatchWorkflow;
  },
}));

import { CONFLICT_RESOLVE_WORKFLOW_FILE } from "@/lib/github/pull-request-repair";

import { resetConflictSweepIntervalForTest, runConflictSweep } from "./conflict-sweep-run";

const MYROOM = {
  id: "repo-myroom",
  fullName: "guchi-apps/myroom",
  ownerLogin: "guchi-apps",
  name: "myroom",
  installation: { installationId: 111 },
};

function openPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 191,
    draft: false,
    base: { ref: "develop" },
    head: { ref: "issue-109", sha: "abc" },
    ...overrides,
  };
}

describe("runConflictSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConflictSweepIntervalForTest();
    delete process.env.CONFLICT_SWEEP_INTERVAL_MINUTES;
    findMany.mockResolvedValue([MYROOM]);
    getInstallationToken.mockResolvedValue("token");
    fetchOpenPullRequests.mockResolvedValue([openPullRequest()]);
    // mergeable=false（コンフリクト）
    fetchPullRequestCiStates.mockResolvedValue(
      new Map([["guchi-apps/myroom#191", { ciState: "success", mergeable: false }]]),
    );
    fetchRepairWorkflowAvailability.mockResolvedValue({ conflict: "available" });
    fetchCheckUserIssueReasons.mockResolvedValue(new Map());
    fetchLatestConflictRepairRuns.mockResolvedValue(new Map());
    recordPullRequestRepairRun.mockResolvedValue(undefined);
    settleResolvedConflictRepairRuns.mockResolvedValue(0);
    dispatchWorkflow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CONFLICT_SWEEP_INTERVAL_MINUTES;
  });

  it("コンフリクトしているPRのコンフリクト解消ワークフローを起動し、実行中として記録する", async () => {
    const result = await runConflictSweep();

    expect(result.swept).toBe(true);
    expect(result.conflicting).toBe(1);
    expect(result.dispatched).toEqual([
      { repositoryFullName: "guchi-apps/myroom", pullRequestNumber: 191, issueNumber: "109" },
    ]);
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      "guchi-apps",
      "myroom",
      CONFLICT_RESOLVE_WORKFLOW_FILE,
      "develop",
      { issue_number: "109" },
      "token",
    );
    expect(recordPullRequestRepairRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "guchi-apps/myroom",
        pullRequestNumber: 191,
        kind: "conflict",
        status: "running",
      }),
    );
  });

  it("コンフリクトしていなければコンフリクト判定までで終わり、何も起動しない", async () => {
    fetchPullRequestCiStates.mockResolvedValue(
      new Map([["guchi-apps/myroom#191", { ciState: "success", mergeable: true }]]),
    );

    const result = await runConflictSweep();

    expect(result.conflicting).toBe(0);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    // コンフリクトしていないPRのためにDBを引きにいかない。
    expect(fetchCheckUserIssueReasons).not.toHaveBeenCalled();
  });

  // 終了の報告が届かないままの行を残すと、そのPRが再びコンフリクトしても`repair_running`で
  // 6時間起動しなくなる（#2165）。
  it("コンフリクトが解消されたPRの「実行中」の行を終わったことにする", async () => {
    fetchPullRequestCiStates.mockResolvedValue(
      new Map([["guchi-apps/myroom#191", { ciState: "success", mergeable: true }]]),
    );

    await runConflictSweep();

    expect(settleResolvedConflictRepairRuns).toHaveBeenCalledWith(
      [{ repositoryFullName: "guchi-apps/myroom", pullRequestNumber: 191 }],
      expect.any(Date),
    );
  });

  it("コンフリクトしたままのPRの行は終わったことにしない", async () => {
    await runConflictSweep();

    expect(settleResolvedConflictRepairRuns).toHaveBeenCalledWith([], expect.any(Date));
  });

  it("issue-<番号>→develop以外のPRはコンフリクト判定すら取りに行かない", async () => {
    fetchOpenPullRequests.mockResolvedValue([
      openPullRequest({ number: 900, base: { ref: "main" }, head: { ref: "develop", sha: "x" } }),
    ]);

    const result = await runConflictSweep();

    expect(result.skipped.no_auto_workflow).toBe(1);
    expect(fetchPullRequestCiStates).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("コンフリクト解消ワークフローが配られていないリポジトリでは起動しない", async () => {
    fetchRepairWorkflowAvailability.mockResolvedValue({ conflict: "unsupported" });

    const result = await runConflictSweep();

    expect(result.skipped.workflow_missing).toBe(1);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("起動に失敗しても巡回は続き、失敗として数える", async () => {
    dispatchWorkflow.mockRejectedValue(new Error("boom"));

    const result = await runConflictSweep();

    expect(result.swept).toBe(true);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped.dispatch_failed).toBe(1);
    expect(recordPullRequestRepairRun).not.toHaveBeenCalled();
  });

  it("起動に失敗したPRへは、待ち時間のあいだ投げ直さない", async () => {
    // `workflow_dispatch`に`issue_number`入力を持たない世代のcallerを置いたままのリポジトリへは
    // 常に422が返る。覚えておかないと巡回のたびに投げ続けることになる。
    dispatchWorkflow.mockRejectedValue(new Error("422"));
    await runConflictSweep();
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);

    const result = await runConflictSweep({ force: true });

    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(result.skipped.recent_failure).toBe(1);
  });

  it("一度起動できれば失敗の記録は消える", async () => {
    dispatchWorkflow.mockRejectedValueOnce(new Error("boom"));
    await runConflictSweep();
    // 待ち時間を跨いだ次の巡回で成功させる。
    await runConflictSweep({
      force: true,
      now: new Date(Date.now() + 31 * 60_000),
    });
    expect(dispatchWorkflow).toHaveBeenCalledTimes(2);

    const result = await runConflictSweep({ force: true });

    expect(result.dispatched).toHaveLength(1);
    expect(dispatchWorkflow).toHaveBeenCalledTimes(3);
  });

  it("1リポジトリのPR取得に失敗しても他のリポジトリの巡回は続く", async () => {
    const carCare = { ...MYROOM, id: "repo-car-care", fullName: "guchi-apps/car-care", name: "car-care" };
    findMany.mockResolvedValue([carCare, MYROOM]);
    fetchOpenPullRequests.mockImplementation(async (_owner: string, repo: string) => {
      if (repo === "car-care") throw new Error("boom");
      return [openPullRequest()];
    });

    const result = await runConflictSweep();

    expect(result.failedRepositories).toEqual(["guchi-apps/car-care"]);
    expect(result.dispatched).toHaveLength(1);
  });

  it("間隔に達していない再呼び出しは巡回しない", async () => {
    await runConflictSweep();
    findMany.mockClear();

    const result = await runConflictSweep();

    expect(result.swept).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("forceを指定すれば間隔を無視して巡回する", async () => {
    await runConflictSweep();
    findMany.mockClear();

    const result = await runConflictSweep({ force: true });

    expect(result.swept).toBe(true);
    expect(findMany).toHaveBeenCalled();
  });

  it("間隔に0を指定すると巡回そのものを止める", async () => {
    process.env.CONFLICT_SWEEP_INTERVAL_MINUTES = "0";

    const result = await runConflictSweep();

    expect(result).toMatchObject({ swept: false, disabled: true });
    expect(findMany).not.toHaveBeenCalled();
  });
});
