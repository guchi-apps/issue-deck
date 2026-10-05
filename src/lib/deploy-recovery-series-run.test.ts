import { beforeEach, describe, expect, it, vi } from "vitest";

import { runDeployRecoverySweep, startDeployRecoverySeries } from "@/lib/deploy-recovery-series-run";

/**
 * 本番復旧系列（#3998）の外部操作の確認。**重複させないこと**（同じ失敗の押し直し・記録失敗後の
 * やり直しでIssueとdispatchが増えない）と、**信頼できない入力で先へ進まないこと**を厚く見る。
 */

type Row = Record<string, unknown> & { id: string };
let rows: Row[] = [];
let nextId = 1;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Record<string, unknown>[]).some((clause) => matches(row, clause));
    if (key === "repositoryFullName_environment_failedRunId_failedRunAttempt") return matches(row, value as Record<string, unknown>);
    if (value && typeof value === "object" && !(value instanceof Date) && typeof value !== "bigint") {
      const condition = value as { not?: unknown; lt?: Date };
      if ("not" in condition) return row[key] !== condition.not;
      if ("lt" in condition) return row[key] instanceof Date && (row[key] as Date) < (condition.lt as Date);
    }
    return row[key] === value;
  });
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

vi.mock("@/lib/db", () => ({
  db: {
    deployRecoverySeries: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = rows.some(
          (row) =>
            (data.activeKey && row.activeKey === data.activeKey) ||
            (row.repositoryFullName === data.repositoryFullName && row.failedRunId === data.failedRunId && row.failedRunAttempt === data.failedRunAttempt),
        );
        if (duplicate) throw uniqueViolation();
        const now = new Date();
        const row: Row = {
          id: `s${nextId++}`,
          issueNumber: null,
          dispatchJobId: null,
          dispatchedAt: null,
          cause: null,
          pullRequestNumber: null,
          repairRoundsBase: 0,
          repairRoundsUsed: 0,
          stopReason: null,
          stopDetail: null,
          lastSweepAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((item) => matches(item, where));
        if (!row) throw new Error("row not found");
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const targets = rows.filter((row) => matches(row, where));
        for (const row of targets) Object.assign(row, data);
        return { count: targets.length };
      }),
    },
    pullRequestAutoRepairLoop: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    repository: { findFirst: vi.fn(async () => ({ installation: { installationId: 1 } })) },
    appSetting: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));

const githubFetch = vi.fn();
vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  githubFetch: (...args: unknown[]) => githubFetch(...args),
}));
const fetchLatestDeployWorkflowRun = vi.fn();
vi.mock("@/lib/github/release-api", () => ({
  fetchLatestDeployWorkflowRun: (...args: unknown[]) => fetchLatestDeployWorkflowRun(...args),
  fetchPackageVersion: vi.fn(async () => "1.2.3"),
}));
vi.mock("@/lib/github/actions-api", () => ({
  fetchWorkflowRunJobs: vi.fn(async () => [{ id: 7, name: "deploy", conclusion: "failure" }]),
  fetchWorkflowJobLogs: vi.fn(async () => "Error: migration failed\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"),
}));
const createIssue = vi.fn();
const createComment = vi.fn();
const fetchOpenIssuesForRepo = vi.fn();
const fetchCommentsForIssue = vi.fn();
const addIssueLabels = vi.fn(async () => []);
vi.mock("@/lib/github/issues-api", () => ({
  createIssue: (...args: unknown[]) => createIssue(...args),
  createComment: (...args: unknown[]) => createComment(...args),
  fetchOpenIssuesForRepo: (...args: unknown[]) => fetchOpenIssuesForRepo(...args),
  fetchCommentsForIssue: (...args: unknown[]) => fetchCommentsForIssue(...args),
  addIssueLabels: (...args: unknown[]) => addIssueLabels(...(args as [])),
}));
const enqueueDispatchJob = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({ enqueueDispatchJob: (...args: unknown[]) => enqueueDispatchJob(...args) }));
vi.mock("@/lib/github/pull-request-auto-repair-start", () => ({ enrollPullRequestAutoRepairLoop: vi.fn(async () => true) }));

const failedRun = {
  id: 100,
  path: ".github/workflows/deploy.yml",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/100",
  head_sha: "abc",
  head_branch: "main",
  run_attempt: 2,
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  rows = [];
  nextId = 1;
  vi.clearAllMocks();
  githubFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions/runs/100")) return jsonResponse(failedRun);
    if (url.includes("status=success")) return jsonResponse({ workflow_runs: [{ head_sha: "good" }] });
    if (url.includes("/pulls?")) return jsonResponse([]);
    throw new Error(`unexpected ${url}`);
  });
  fetchLatestDeployWorkflowRun.mockResolvedValue({ id: 100 });
  fetchOpenIssuesForRepo.mockResolvedValue([]);
  createIssue.mockResolvedValue({ number: 55 });
  enqueueDispatchJob.mockResolvedValue({ ok: true, job: { id: "job1" } });
});

const start = () => startDeployRecoverySeries({ repositoryFullName: "o/r", runId: 100, userId: "u1", token: "t" });

describe("startDeployRecoverySeries", () => {
  it("同じ失敗の押し直しは同じ系列を返す", async () => {
    const first = await start();
    const second = await start();
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startedByUserId: "u1", scope: "fix_until_develop", failedRunAttempt: 2, activeKey: "o/r" });
  });

  it("別の失敗の系列が進行中なら始めない", async () => {
    await start();
    rows[0].failedRunId = BigInt(99);
    expect(await start()).toMatchObject({ ok: false, error: "series_active" });
  });

  it("最新でない失敗・失敗していない実行からは始めない", async () => {
    fetchLatestDeployWorkflowRun.mockResolvedValue({ id: 101 });
    expect(await start()).toEqual({ ok: false, error: "not_latest_failure" });
    githubFetch.mockResolvedValueOnce(jsonResponse({ ...failedRun, conclusion: "success" }));
    expect(await start()).toEqual({ ok: false, error: "deploy_not_failed" });
    expect(rows).toHaveLength(0);
  });
});

describe("runDeployRecoverySweep", () => {
  it("修正Issueを1件作って実装を起動し、ログの秘密値は伏せる", async () => {
    await start();
    const result = await runDeployRecoverySweep({ hostName: "subpc" });
    expect(result.actions).toEqual([expect.objectContaining({ action: "dispatched", detail: "#55" })]);
    expect(createIssue).toHaveBeenCalledTimes(1);
    const body = (createIssue.mock.calls[0][3] as { body: string }).body;
    expect(body).toContain("<!-- issue-deck-deploy-recovery-series:s1 -->");
    expect(body).toContain("migration failed");
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(enqueueDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 55, hostName: "subpc", agent: "claude" }));
    expect(rows[0]).toMatchObject({ status: "investigating", issueNumber: 55, dispatchJobId: "job1" });
  });

  it("記録に失敗したやり直しでは、自分のIssueを探し直し、起動済みのdispatchを成功として進める", async () => {
    await start();
    fetchOpenIssuesForRepo.mockResolvedValue([{ number: 77, title: "x", body: "...<!-- issue-deck-deploy-recovery-series:s1 -->" }]);
    enqueueDispatchJob.mockResolvedValue({ ok: false, rejection: "already_queued", message: "積まれています" });
    await runDeployRecoverySweep({ hostName: "subpc" });
    expect(createIssue).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "investigating", issueNumber: 77 });
  });

  it("人が先に立てた修正Issueは増やさずに使う", async () => {
    await start();
    fetchOpenIssuesForRepo.mockResolvedValue([{ number: 60, title: "[デプロイ失敗の修正] v1.2.3の本番デプロイが失敗する原因を直す", body: "下書き" }]);
    await runDeployRecoverySweep({ hostName: "subpc" });
    expect(createIssue).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith("o", "r", 60, "token", expect.anything());
    expect(rows[0]).toMatchObject({ issueNumber: 60 });
  });

  it("起動できない理由なら止めて知らせる", async () => {
    await start();
    enqueueDispatchJob.mockResolvedValue({ ok: false, rejection: "repository_not_runnable", message: "このホストでは実行できません" });
    await runDeployRecoverySweep({ hostName: "subpc" });
    expect(rows[0]).toMatchObject({ status: "needs_attention", activeKey: null, stopReason: "dispatch_failed" });
    expect(addIssueLabels).toHaveBeenCalledWith("o", "r", 55, "token", ["00.check-user", "01.check-blocked"]);
  });

  it("原因の区分は信頼できる投稿者の報告だけを読み、指示文の例示は読まない", async () => {
    await start();
    await runDeployRecoverySweep({ hostName: "subpc" });
    rows[0].lastSweepAt = null;
    const after = new Date(Date.now() + 1000).toISOString();
    fetchCommentsForIssue.mockResolvedValue([
      { body: "<!-- issue-deck-deploy-recovery-cause:config -->", created_at: after, user: { login: "stranger" }, author_association: "NONE" },
      { body: "例 <!-- issue-deck-deploy-recovery-cause:unknown --> <!-- issue-deck-deploy-recovery-series:s1 -->", created_at: after, user: { login: "issue-deck[bot]" } },
    ]);
    await runDeployRecoverySweep({ hostName: "subpc" });
    expect(rows[0].status).toBe("investigating");

    rows[0].lastSweepAt = null;
    fetchCommentsForIssue.mockResolvedValue([
      { body: "原因はコードです <!-- issue-deck-deploy-recovery-cause:code -->", created_at: after, user: { login: "owner" }, author_association: "OWNER" },
    ]);
    await runDeployRecoverySweep({ hostName: "subpc" });
    expect(rows[0]).toMatchObject({ status: "fixing", cause: "code" });
  });

  it("同じ巡回の間隔内に2本目のpollerが来ても進めない", async () => {
    await start();
    await Promise.all([runDeployRecoverySweep({ hostName: "subpc" }), runDeployRecoverySweep({ hostName: "subpc" })]);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(enqueueDispatchJob).toHaveBeenCalledTimes(1);
  });
});
