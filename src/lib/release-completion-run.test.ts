import { beforeEach, describe, expect, it, vi } from "vitest";

import { runReleaseCompletionSweep, startReleaseCompletionRun, stopReleaseCompletionRun } from "@/lib/release-completion-run";

/**
 * リリース完了系列（#4480）の外部操作の確認。**重複させないこと**（起動・マージ）と、**記録と違う候補・
 * 停止後・未確認のまま先へ進まないこと**を厚く見る。判断そのものは`release-completion.test.ts`で見る。
 */

type Row = Record<string, unknown> & { id: string };
let runs: Row[] = [];
let fixSeries: Row[] = [];
let recoveries: Row[] = [];
let nextId = 1;
let afterUpdateMany: ((data: Record<string, unknown>) => Promise<void>) | null = null;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Record<string, unknown>[]).some((clause) => matches(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date) && typeof value !== "bigint") {
      const condition = value as { not?: unknown; lt?: Date; in?: unknown[] };
      if ("in" in condition) return (condition.in ?? []).includes(row[key]);
      if ("not" in condition) return row[key] !== condition.not && !(condition.not !== null && row[key] === null);
      if ("lt" in condition) return row[key] instanceof Date && (row[key] as Date) < (condition.lt as Date);
    }
    return row[key] === value;
  });
}

function table(store: () => Row[]) {
  return {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store().find((row) => matches(row, where)) ?? null),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = store().filter((row) => matches(row, where));
      return found[found.length - 1] ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store().filter((row) => matches(row, where)).map((row) => ({ ...row }))),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = store().find((item) => matches(item, where));
      if (!row) throw new Error("row not found");
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const targets = store().filter((row) => matches(row, where));
      for (const row of targets) Object.assign(row, data);
      await afterUpdateMany?.(data);
      return { count: targets.length };
    }),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    releaseCompletionRun: {
      ...table(() => runs),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (runs.some((row) => data.activeKey && row.activeKey === data.activeKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const now = new Date();
        const row: Row = {
          id: `r${nextId++}`,
          dispatchedSeriesId: null,
          dispatchedAt: null,
          costUsedUsd: 0,
          mergeSha: null,
          mergedByRun: false,
          releaseStartedAt: null,
          releaseRunId: null,
          releaseRunUrl: null,
          completedAt: null,
          deployRecoverySeriesId: null,
          note: null,
          stopReason: null,
          stopDetail: null,
          stoppedByUserId: null,
          stoppedAt: null,
          lastSweepAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        runs.push(row);
        return { ...row };
      }),
    },
    releaseFixSeries: table(() => fixSeries),
    deployRecoverySeries: table(() => recoveries),
    sessionUsage: { aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })) },
    repository: { findFirst: vi.fn(async () => ({ installation: { installationId: 1 } })) },
    appSetting: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));

const fetchPullRequest = vi.fn();
const mergePullRequest = vi.fn();
vi.mock("@/lib/github/actions-api", () => ({
  fetchPullRequest: (...args: unknown[]) => fetchPullRequest(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  fetchWorkflowRunJobs: vi.fn(async () => [{ name: "deploy", conclusion: "failure" }]),
}));
const fetchMainHeadSha = vi.fn();
const fetchPullRequestCiState = vi.fn();
vi.mock("@/lib/github/release-api", () => ({
  fetchMainHeadSha: (...args: unknown[]) => fetchMainHeadSha(...args),
  fetchPullRequestCiState: (...args: unknown[]) => fetchPullRequestCiState(...args),
}));
const recordDeployLaunchWatch = vi.fn(async () => true);
vi.mock("@/lib/github/deploy-launch-watch", () => ({ recordDeployLaunchWatch: (...args: unknown[]) => recordDeployLaunchWatch(...(args as [])) }));
const createComment = vi.fn(async () => ({}));
const addIssueLabels = vi.fn(async () => []);
vi.mock("@/lib/github/issues-api", () => ({
  createComment: (...args: unknown[]) => createComment(...(args as [])),
  addIssueLabels: (...args: unknown[]) => addIssueLabels(...(args as [])),
}));
const enqueueDispatchJob = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({ enqueueDispatchJob: (...args: unknown[]) => enqueueDispatchJob(...args) }));

const loadReleaseVerificationSummary = vi.fn();
vi.mock("@/lib/release-verification-load", () => ({
  loadReleaseVerificationSummary: (...args: unknown[]) => loadReleaseVerificationSummary(...args),
}));
const listReleaseVerificationRecords = vi.fn();
vi.mock("@/lib/release-verification", () => ({
  listReleaseVerificationRecords: (...args: unknown[]) => listReleaseVerificationRecords(...args),
}));
const createReleaseFixSeries = vi.fn();
vi.mock("@/lib/release-fix-series-run", () => ({
  createReleaseFixSeries: (...args: unknown[]) => createReleaseFixSeries(...args),
  readReleaseFixStartState: vi.fn(async () => "none"),
}));
const fetchDeployRunsForSha = vi.fn();
const hasVersionVerification = vi.fn();
const startDeployRecoverySeries = vi.fn();
const stopDeployRecoverySeries = vi.fn(async () => null);
vi.mock("@/lib/deploy-recovery-series-run", () => ({
  fetchDeployRunsForSha: (...args: unknown[]) => fetchDeployRunsForSha(...args),
  hasVersionVerification: (...args: unknown[]) => hasVersionVerification(...args),
  startDeployRecoverySeries: (...args: unknown[]) => startDeployRecoverySeries(...args),
  stopDeployRecoverySeries: (...args: unknown[]) => stopDeployRecoverySeries(...(args as [])),
  toDeployRecoverySeriesView: (row: Row) => ({ id: row.id, status: row.status, statusLabel: String(row.status), issueNumber: null, stopMessage: null }),
}));

function section(state: string, findings: unknown[] = []) {
  return { state, reason: null, summary: null, findings };
}
function summary(ai: string, integration: string, findings: unknown[] = []) {
  return { aiReview: section(ai, findings), integration: section(integration), mac: { state: "not_applicable" } };
}
function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    state: "open",
    merged: false,
    merge_commit_sha: null,
    mergeable: true,
    labels: [],
    head: { ref: "release-main/v1.2.3", sha: "head1" },
    base: { ref: "main", sha: "base1" },
    ...overrides,
  };
}
const passedRecords = [
  { kind: "integration", state: "passed", baseSha: "base1", headSha: "head1" },
  { kind: "ai_review", state: "passed", baseSha: "base1", headSha: "head1" },
];

const now = new Date("2026-10-12T12:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60 * 1000);

async function start(scope: "until_ready" | "until_production" = "until_production") {
  return startReleaseCompletionRun({ owner: "o", repo: "r", token: "t", userId: "u1", pullRequestNumber: 10, scope, now });
}

beforeEach(() => {
  runs = [];
  fixSeries = [];
  recoveries = [];
  nextId = 1;
  afterUpdateMany = null;
  vi.clearAllMocks();
  fetchPullRequest.mockResolvedValue(pull());
  loadReleaseVerificationSummary.mockResolvedValue(summary("failed", "passed", [{ title: "認可漏れ" }]));
  listReleaseVerificationRecords.mockResolvedValue(passedRecords);
  fetchMainHeadSha.mockResolvedValue("base1");
  fetchPullRequestCiState.mockResolvedValue({ ciState: "success", mergeable: true });
  enqueueDispatchJob.mockResolvedValue({ ok: true, job: { id: "j1" } });
  mergePullRequest.mockResolvedValue({ sha: "merge1" });
});

describe("startReleaseCompletionRun", () => {
  it("問題の無い候補からは始めない（通常のリリースは人がマージする）", async () => {
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    expect(await start()).toEqual({ ok: false, error: "nothing_to_recover" });
    expect(runs).toHaveLength(0);
  });

  it("問題がある候補で開始し、同じリポジトリで2本目は始めない", async () => {
    const first = await start();
    expect(first).toMatchObject({ ok: true, created: true });
    expect(runs[0]).toMatchObject({ scope: "until_production", startedByUserId: "u1", activeKey: "o/r", candidateHeadSha: "head1" });
    // 同じ候補の押し直しは同じ系列を返す
    expect(await start()).toMatchObject({ ok: true, created: false });
    fetchPullRequest.mockResolvedValue(pull({ number: 12 }));
    const other = await startReleaseCompletionRun({ owner: "o", repo: "r", token: "t", userId: "u1", pullRequestNumber: 12, scope: "until_ready", now });
    expect(other).toMatchObject({ ok: false, error: "run_active" });
  });

  it("画面で見ていたSHAと今の候補が違えば始めない", async () => {
    const result = await startReleaseCompletionRun({
      owner: "o",
      repo: "r",
      token: "t",
      userId: "u1",
      pullRequestNumber: 10,
      headSha: "old",
      scope: "until_production",
      now,
    });
    expect(result).toEqual({ ok: false, error: "release_pr_changed" });
  });
});

describe("runReleaseCompletionSweep", () => {
  it("指摘から修正を起案し、修正Issueを1回だけ起動する", async () => {
    await start();
    createReleaseFixSeries.mockImplementation(async () => {
      fixSeries.push({ id: "s1", repositoryFullName: "o/r", releasePrNumber: 10, successorPrNumber: null, status: "issue_created", issueNumber: 100, createdAt: now });
      return { outcome: "created", series: { issueNumber: 100 } };
    });
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(createReleaseFixSeries).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "review_finding", findingIndexes: [0], userId: "u1" }));
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(2) });
    expect(enqueueDispatchJob).toHaveBeenCalledTimes(1);
    expect(enqueueDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 100, hostName: "subpc", requestedByUserId: "u1" }));
    expect(runs[0]).toMatchObject({ status: "fixing", dispatchedSeriesId: "s1" });
  });

  it("修正系列が作り直した後継へ追従し、合格すれば記録したHEADで本番へマージして追跡を始める", async () => {
    await start();
    fixSeries.push({
      id: "s1",
      repositoryFullName: "o/r",
      releasePrNumber: 10,
      successorPrNumber: 11,
      successorHeadSha: "head2",
      successorBaseSha: "base1",
      status: "reverifying",
      issueNumber: 100,
      createdAt: now,
    });
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(runs[0]).toMatchObject({ candidatePrNumber: 11, candidateHeadSha: "head2", status: "checking", candidatePrNumbers: [10, 11] });

    fixSeries[0].status = "ready";
    fetchPullRequest.mockResolvedValue(pull({ number: 11, head: { ref: "release-main/v1.2.3", sha: "head2" } }));
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    listReleaseVerificationRecords.mockResolvedValue(passedRecords.map((r) => ({ ...r, headSha: "head2" })));
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).toHaveBeenCalledWith("o", "r", 11, "token", "head2");
    expect(runs[0]).toMatchObject({ status: "releasing", mergeSha: "merge1", mergedByRun: true });
  });

  it("マージ応答にSHAが無くても次の巡回で確定したSHAの起動監視を登録する", async () => {
    await start();
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    mergePullRequest.mockResolvedValue({ sha: null });
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(runs[0]).toMatchObject({ status: "merging", mergeSha: null, mergedByRun: true });
    recordDeployLaunchWatch.mockClear();
    fetchPullRequest.mockResolvedValue(pull({ state: "closed", merged: true, merge_commit_sha: "recovered-sha" }));
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(runs[0]).toMatchObject({ status: "releasing", mergeSha: "recovered-sha", mergedByRun: true });
    expect(recordDeployLaunchWatch).toHaveBeenCalledWith({ owner: "o", repo: "r", pullRequestNumber: 10, mergeCommitSha: "recovered-sha", token: "token" });
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("チェック通過までの系列は本番へマージせず、人がマージしたら稼働確認まで追跡する", async () => {
    await start("until_ready");
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(runs[0].status).toBe("awaiting_approval");
    expect(mergePullRequest).not.toHaveBeenCalled();

    fetchPullRequest.mockResolvedValue(pull({ state: "closed", merged: true, merge_commit_sha: "merge9" }));
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(runs[0]).toMatchObject({ status: "releasing", mergeSha: "merge9", mergedByRun: false });
  });

  it("mainが進んでいたらマージせず、理由を付けて人へ渡す", async () => {
    await start();
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    fetchMainHeadSha.mockResolvedValue("base2");
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "needs_attention", stopReason: "base_changed", activeKey: null });
    expect(createComment).toHaveBeenCalled();
  });

  it("停止した系列は巡回の対象にならず、マージもしない", async () => {
    await start();
    await stopReleaseCompletionRun({ repositoryFullName: "o/r", runId: runs[0].id, userId: "u1", token: "t", now });
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    const result = await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(result.scanned).toBe(0);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "stopped", stoppedByUserId: "u1" });
  });

  it("マージ実行権を取得した直後の停止でも本番マージを行わない", async () => {
    await start();
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "passed"));
    afterUpdateMany = async (data) => {
      if (data.status !== "merging") return;
      afterUpdateMany = null;
      await stopReleaseCompletionRun({ repositoryFullName: "o/r", runId: runs[0].id, userId: "u1", token: "t", now });
    };
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "stopped", activeKey: null });
  });

  it("未導入リポジトリの統合検証失敗は設定不足として止め、修正を起案しない", async () => {
    await start();
    loadReleaseVerificationSummary.mockResolvedValue(summary("passed", "failed"));
    await runReleaseCompletionSweep({ hostName: "subpc", now });
    expect(createReleaseFixSeries).not.toHaveBeenCalled();
    expect(enqueueDispatchJob).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: "needs_attention", stopReason: "setup_missing", activeKey: null });
  });

  it("deployの成功と稼働版の一致で完了。成功でも稼働版を確かめられなければ完了にしない", async () => {
    await start();
    Object.assign(runs[0], { status: "releasing", mergeSha: "merge1", releaseStartedAt: now });
    const success = { id: 5, htmlUrl: "u5", createdAt: now.toISOString(), headSha: "merge1", status: "completed", conclusion: "success", attempt: 1 };
    fetchDeployRunsForSha.mockResolvedValue([success]);
    hasVersionVerification.mockResolvedValue(false);
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(runs[0].status).toBe("verifying");
    hasVersionVerification.mockResolvedValue(true);
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(2) });
    expect(runs[0]).toMatchObject({ status: "completed", activeKey: null });
  });

  it("deployが再実行も失敗したら、同じ系列のまま本番復旧へ引き継ぎ、その復旧で完了する", async () => {
    await start();
    Object.assign(runs[0], { status: "releasing", mergeSha: "merge1", releaseStartedAt: now });
    fetchDeployRunsForSha.mockResolvedValue([
      { id: 6, htmlUrl: "u6", createdAt: now.toISOString(), headSha: "merge1", status: "completed", conclusion: "failure", attempt: 2 },
    ]);
    startDeployRecoverySeries.mockImplementation(async () => {
      recoveries.push({ id: "d1", status: "starting" });
      return { ok: true, created: true, series: { id: "d1" } };
    });
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(1) });
    expect(startDeployRecoverySeries).toHaveBeenCalledWith(expect.objectContaining({ runId: 6, userId: "u1", scope: "fix_until_main" }));
    expect(runs[0]).toMatchObject({ status: "deploy_recovery", deployRecoverySeriesId: "d1" });

    Object.assign(recoveries[0], { status: "recovered", recoveredAt: later(30), releaseRunUrl: "u7" });
    await runReleaseCompletionSweep({ hostName: "subpc", now: later(31) });
    expect(runs[0]).toMatchObject({ status: "completed", activeKey: null });
  });
});
