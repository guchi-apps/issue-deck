import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * バックアップCI（#4065）のサービス層。DBはメモリ上の簡易実装、GitHub・CircleCIはfetchのスタブで置き換え、
 * 二重起動・応答不明・Webhookの重複/不正署名・head/base更新・遅延通知での振る舞いを確かめる。
 */

type Row = Record<string, unknown> & { id: string };
const runs: Row[] = [];
const settings = new Map<string, Row>();
const deliveries = new Set<string>();
const gateStates: Row[] = [];
let seq = 0;

function uniqueError() {
  return Object.assign(new Error("unique"), { code: "P2002" });
}
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Record<string, unknown>[]).some((w) => matches(row, w));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const cond = value as { in?: unknown[]; gte?: Date; lt?: Date };
      if (cond.in) return cond.in.includes(row[key]);
      if (cond.gte) return row[key] instanceof Date && (row[key] as Date) >= cond.gte;
      if (cond.lt) return row[key] instanceof Date && (row[key] as Date) < cond.lt;
    }
    return row[key] === value;
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      findFirst: async () => ({ fullName: "o/r", installation: { installationId: 1 } }),
    },
    backupCiSetting: {
      findUnique: async ({ where }: { where: { repositoryFullName: string } }) =>
        settings.get(where.repositoryFullName) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...settings.values()].filter((r) => matches(r, where)),
    },
    ciGateState: {
      findUnique: async ({ where }: { where: { repositoryFullName_prNumber: Record<string, unknown> } }) =>
        gateStates.find((r) => matches(r, where.repositoryFullName_prNumber)) ?? null,
      findMany: async () => gateStates.map((r) => ({ ...r })),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { repositoryFullName_prNumber: Record<string, unknown> };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = gateStates.find((r) => matches(r, where.repositoryFullName_prNumber));
        if (row) return Object.assign(row, update);
        const created: Row = { id: `gate${++seq}`, ...create };
        gateStates.push(created);
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(gateStates.find((r) => r.id === where.id)!, data),
      deleteMany: async () => ({ count: 0 }),
    },
    backupCiRun: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => runs.find((r) => matches(r, where)) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        runs.filter((r) => matches(r, where)).sort((a, b) => (b.attempt as number) - (a.attempt as number))[0] ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => runs.filter((r) => matches(r, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.activeKey && runs.some((r) => r.activeKey === data.activeKey)) throw uniqueError();
        const row: Row = {
          id: `run${++seq}`,
          requestedAt: new Date(),
          completedAt: null,
          triggeredAt: null,
          gateState: null,
          logUrl: null,
          statusReason: null,
          externalPipelineId: null,
          externalPipelineNumber: null,
          ...data,
        };
        runs.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = runs.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
    },
    circleciWebhookDelivery: {
      create: async ({ data }: { data: { eventId: string } }) => {
        if (deliveries.has(data.eventId)) throw uniqueError();
        deliveries.add(data.eventId);
        return data;
      },
      delete: async ({ where }: { where: { eventId: string } }) => deliveries.delete(where.eventId),
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: async () => "gh-token" }));

const service = await import("@/lib/backup-ci/service");
const gateService = await import("@/lib/backup-ci/gate-service");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const definitionRaw = readFileSync("ci/required-checks.json");
const definitionChecks = Object.entries(
  JSON.parse(definitionRaw.toString()).groups as Record<string, { checks: { id: string }[] }>,
).flatMap(([group, g]) => g.checks.map((c) => ({ group, id: c.id, status: "passed" })));

let pr = { headSha: HEAD, baseSha: BASE, state: "open" };
let triggerResponse: () => Promise<Response>;
let workflowStatus = "success";
let resultOverrides: Record<string, unknown> = {};
const statuses: { sha: string; state: string }[] = [];
let triggerCalls = 0;
/** GitHub Actions（ci.yml）の実行。`/actions/runs?head_sha=`の応答になる */
type ActionsRun = {
  id: number;
  path?: string;
  run_attempt?: number;
  status: string;
  run_started_at: string;
  jobs: { name: string; status: string; conclusion: string | null }[];
};
let actionsRuns: ActionsRun[] = [];
const REQUIRED_GROUPS = ["lint-and-build", "docs-sync-check", "workflow-expression-length-check"];
function actionsRun(id: number, startedAt: Date, conclusion: string | null, overrides: Partial<ActionsRun> = {}): ActionsRun {
  return {
    id,
    status: conclusion ? "completed" : "in_progress",
    run_started_at: startedAt.toISOString(),
    jobs: [...REQUIRED_GROUPS, "notify"].map((name) => ({
      name,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
    })),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  runs.length = 0;
  deliveries.clear();
  settings.clear();
  gateStates.length = 0;
  actionsRuns = [];
  statuses.length = 0;
  triggerCalls = 0;
  pr = { headSha: HEAD, baseSha: BASE, state: "open" };
  workflowStatus = "success";
  resultOverrides = {};
  settings.set("o/r", {
    id: "o/r",
    repositoryFullName: "o/r",
    enabled: true,
    circleciProjectSlug: "circleci/org/proj",
    circleciDefinitionId: "0123abcd-0000-0000-0000-000000000000",
  });
  vi.stubEnv("CIRCLECI_API_TOKEN", "cci-token");
  vi.stubEnv("CIRCLECI_WEBHOOK_SECRET", "hook-secret");
  triggerResponse = async () => json({ id: "pipe-1", number: 7 }, 201);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/pulls?state=open")) {
        return json([
          {
            number: 1,
            state: pr.state,
            head: { sha: pr.headSha, ref: "issue-1", repo: { full_name: "o/r" } },
            base: { sha: pr.baseSha, ref: "develop" },
          },
        ]);
      }
      if (url.includes("/actions/runs?head_sha=")) {
        return json({
          workflow_runs: actionsRuns.map((run) => ({
            id: run.id,
            path: run.path ?? ".github/workflows/ci.yml",
            event: "pull_request",
            head_sha: pr.headSha,
            head_branch: "issue-1",
            status: run.status,
            run_attempt: run.run_attempt ?? 1,
            run_started_at: run.run_started_at,
            html_url: `https://github.com/o/r/actions/runs/${run.id}`,
            pull_requests: [{ number: 1 }],
          })),
        });
      }
      const jobsMatch = url.match(/\/actions\/runs\/(\d+)\/jobs/);
      if (jobsMatch) {
        return json({ jobs: actionsRuns.find((run) => run.id === Number(jobsMatch[1]))?.jobs ?? [] });
      }
      if (url.includes("/pulls/")) {
        return json({
          state: pr.state,
          head: { sha: pr.headSha, ref: "issue-1", repo: { full_name: "o/r" } },
          base: { sha: pr.baseSha, ref: "develop" },
        });
      }
      if (url.includes("/contents/ci/required-checks.json")) {
        return json({ encoding: "base64", content: definitionRaw.toString("base64") });
      }
      if (url.includes("/statuses/")) {
        statuses.push({ sha: url.split("/statuses/")[1], state: JSON.parse(String(init?.body)).state });
        return json({}, 201);
      }
      if (url.endsWith("/pipeline/run")) {
        triggerCalls += 1;
        return triggerResponse();
      }
      if (url.endsWith("/pipeline/pipe-1/workflow")) {
        return json({ items: [{ id: "wf-1", name: "backup-ci", status: workflowStatus }] });
      }
      if (url.endsWith("/workflow/wf-1/job")) {
        return json({ items: [{ job_number: 42, name: "required-checks", status: workflowStatus }] });
      }
      if (url.endsWith("/circleci/org/proj/42/artifacts")) {
        return json({ items: [{ path: "backup-ci/ci-result.json", url: "https://artifact/ci-result.json" }] });
      }
      if (url === "https://artifact/ci-result.json") {
        const run = runs[0];
        return json({
          schemaVersion: 1,
          definitionDigest: run.definitionDigest,
          requestedHeadSha: run.headSha,
          requestedBaseSha: run.baseSha,
          runRequestId: run.id,
          testedSha: "c".repeat(40),
          testedParents: [run.baseSha, run.headSha],
          checks: definitionChecks,
          ...resultOverrides,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function signedWebhook(eventId: string, secret = "hook-secret") {
  const body = JSON.stringify({ id: eventId, type: "workflow-completed", pipeline: { id: "pipe-1" }, workflow: { id: "wf-1" } });
  return { body, signature: `v1=${createHmac("sha256", secret).update(body).digest("hex")}` };
}

describe("startBackupCiRun", () => {
  it("起動して実行中になり、共通チェックをpendingで出す", async () => {
    const { run, reused } = await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    expect(reused).toBe(false);
    expect(run.status).toBe("running");
    expect(run.externalPipelineId).toBe("pipe-1");
    expect(run.definitionDigest).toMatch(/^sha256:/);
    expect(statuses).toEqual([{ sha: HEAD, state: "pending" }]);
  });

  it("実行中に押し直しても新しく起動しない（二重起動を防ぐ）", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    const second = await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    expect(second.reused).toBe(true);
    expect(triggerCalls).toBe(1);
  });

  it("応答不明なら結果確認不能で止め、再送しない", async () => {
    triggerResponse = async () => {
      throw new Error("timeout");
    };
    const { run } = await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    expect(run.status).toBe("trigger_unknown");
    expect(triggerCalls).toBe(1);
    expect(statuses.at(-1)?.state).toBe("error");
  });

  it("CircleCIが拒否したら理由を記録する", async () => {
    triggerResponse = async () => json({ message: "Not Found" }, 404);
    const { run } = await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    expect(run.status).toBe("trigger_failed");
    expect(run.statusReason).toContain("プロジェクト");
  });

  it("有効化していないリポジトリでは起動できない", async () => {
    settings.set("o/r", { id: "o/r", enabled: false, circleciProjectSlug: null, circleciDefinitionId: null });
    await expect(service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" })).rejects.toThrow(
      /有効/,
    );
    expect(triggerCalls).toBe(0);
  });
});

describe("handleCircleciWebhook", () => {
  it("署名が正しい完了通知で結果を照合し、合格なら共通チェックをsuccessにする", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    const { body, signature } = signedWebhook("evt-1");
    const outcome = await service.handleCircleciWebhook(body, signature);
    expect(outcome).toMatchObject({ kind: "processed", status: "passed" });
    expect(statuses.at(-1)).toEqual({ sha: HEAD, state: "success" });
  });

  it("同じイベントの再送は処理しない", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    const { body, signature } = signedWebhook("evt-1");
    await service.handleCircleciWebhook(body, signature);
    await expect(service.handleCircleciWebhook(body, signature)).resolves.toEqual({ kind: "duplicate" });
  });

  it("署名が不正なWebhookでは合格を作れない", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    const { body } = signedWebhook("evt-1");
    const forged = signedWebhook("evt-1", "attacker").signature;
    await expect(service.handleCircleciWebhook(body, forged)).resolves.toEqual({ kind: "unauthorized" });
    expect(runs[0].status).toBe("running");
  });

  it("検査の欠落・失敗は合格にしない", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    resultOverrides = { checks: definitionChecks.filter((c) => c.id !== "workflow-job-permissions") };
    const { body, signature } = signedWebhook("evt-1");
    await expect(service.handleCircleciWebhook(body, signature)).resolves.toMatchObject({ status: "invalid" });
    expect(statuses.at(-1)?.state).toBe("failure");
  });

  it("実行中にheadが更新されたら、合格でも採用しない", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    pr = { ...pr, headSha: "d".repeat(40) };
    const { body, signature } = signedWebhook("evt-1");
    await expect(service.handleCircleciWebhook(body, signature)).resolves.toMatchObject({ status: "superseded" });
    expect(statuses.filter((s) => s.state === "success")).toHaveLength(0);
  });
});

describe("sweepBackupCiRuns", () => {
  it("Webhookが届かなくても巡回で結果を回収する", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    expect(runs[0].status).toBe("passed");
  });

  it("合格の後にbaseが更新されたら無効にし、共通チェックをpendingへ戻す", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    pr = { ...pr, baseSha: "e".repeat(40) };
    runs[0].lastReconciledAt = null;
    await service.sweepBackupCiRuns();
    expect(runs[0].status).toBe("superseded");
    expect(statuses.at(-1)).toEqual({ sha: HEAD, state: "pending" });
  });

  it("完了済みの実行に遅れて届いた通知で状態を巻き戻さない", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    workflowStatus = "failed";
    const { body, signature } = signedWebhook("evt-late");
    await service.handleCircleciWebhook(body, signature);
    expect(runs[0].status).toBe("passed");
  });

  it("時間切れは結果確認不能", async () => {
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    workflowStatus = "running";
    await service.sweepBackupCiRuns(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(runs[0].status).toBe("unverifiable");
  });
});

describe("通常時のActionsの結果を共通チェックへ写す（#4113）", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);
  const syncNow = () =>
    gateService.syncPullRequestCiGate({
      repositoryFullName: "o/r",
      prNumber: 1,
      pr: { state: "open", headSha: pr.headSha, headRef: "issue-1", headRepoFullName: "o/r", baseSha: pr.baseSha, baseRef: "develop" },
      token: "gh-token",
    });

  beforeEach(() => {
    settings.set("o/r", { ...settings.get("o/r")!, mirrorActionsToCiGate: true });
  });

  it("必須ジョブが全部成功したらActions経由でsuccessを出し、経路を記録する", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), "success")];
    await expect(syncNow()).resolves.toMatchObject({ source: "actions", state: "success" });
    expect(statuses).toEqual([{ sha: HEAD, state: "success" }]);
    expect(gateStates[0]).toMatchObject({ source: "actions", sourceRef: "10:1", state: "success", headSha: HEAD });
  });

  it("同じ結果は発行し直さない", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), "success")];
    await syncNow();
    await syncNow();
    expect(statuses).toHaveLength(1);
  });

  it("必須ジョブ以外の失敗は数えず、必須ジョブの失敗・欠落・スキップは成功にしない", async () => {
    const run = actionsRun(10, minutesAgo(5), "success");
    run.jobs.find((j) => j.name === "notify")!.conclusion = "failure";
    actionsRuns = [run];
    await expect(syncNow()).resolves.toMatchObject({ state: "success" });

    actionsRuns = [actionsRun(11, minutesAgo(4), "success")];
    actionsRuns[0].jobs = actionsRuns[0].jobs.filter((j) => j.name !== "docs-sync-check");
    await expect(syncNow()).resolves.toMatchObject({ state: "error" });

    actionsRuns = [actionsRun(12, minutesAgo(3), "success")];
    actionsRuns[0].jobs.find((j) => j.name === "lint-and-build")!.conclusion = "skipped";
    await expect(syncNow()).resolves.toMatchObject({ state: "error" });

    actionsRuns = [actionsRun(13, minutesAgo(2), "success")];
    actionsRuns[0].jobs.find((j) => j.name === "lint-and-build")!.conclusion = "failure";
    await expect(syncNow()).resolves.toMatchObject({ state: "failure" });
  });

  it("ci.yml以外のワークフローの同名ジョブでは合格を作れない", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), null), actionsRun(20, minutesAgo(1), "success", { path: ".github/workflows/fake.yml" })];
    await expect(syncNow()).resolves.toMatchObject({ source: "actions", state: "pending" });
  });

  it("後の実行の結果を使い、前の実行の成功を選び取らない", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(10), "success"), actionsRun(11, minutesAgo(2), "failure")];
    await expect(syncNow()).resolves.toMatchObject({ state: "failure" });
  });

  it("Actionsが止まっている間にバックアップCIが合格すればsuccessになり、遅れて届いたActionsの失敗で巻き戻さない", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(30), null)];
    await expect(syncNow()).resolves.toMatchObject({ source: "actions", state: "pending" });
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    expect(gateStates[0]).toMatchObject({ source: "backup", state: "success" });
    expect(statuses.at(-1)).toEqual({ sha: HEAD, state: "success" });

    // 止まっていたActionsの実行（バックアップCIより前に始まった）が遅れて失敗で終わる
    actionsRuns = [actionsRun(10, minutesAgo(30), "failure")];
    await expect(syncNow()).resolves.toMatchObject({ source: "backup", state: "success" });
    expect(statuses.at(-1)).toEqual({ sha: HEAD, state: "success" });
  });

  it("バックアップCIの後にActionsで再実行したら、再実行の結果を採用する", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(30), null)];
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    actionsRuns = [actionsRun(10, new Date(Date.now() + 60 * 1000), "failure", { run_attempt: 2 })];
    await expect(syncNow()).resolves.toMatchObject({ source: "actions", state: "failure" });
    expect(gateStates[0]).toMatchObject({ sourceRef: "10:2" });
  });

  it("バックアップCIの合格の後にbaseが更新されたら、Actionsの結果へ戻す（古い合格を流用しない）", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(30), null)];
    await service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" });
    await service.sweepBackupCiRuns();
    pr = { ...pr, baseSha: "e".repeat(40) };
    runs[0].lastReconciledAt = null;
    await service.sweepBackupCiRuns();
    expect(runs[0].status).toBe("superseded");
    expect(gateStates[0]).toMatchObject({ source: "actions", state: "pending", baseSha: "e".repeat(40) });
    expect(statuses.at(-1)).toEqual({ sha: HEAD, state: "pending" });
  });

  it("Actionsが検査を失敗で終えているPRでは、バックアップCIを起動しない", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), "failure")];
    await expect(service.startBackupCiRun({ repositoryFullName: "o/r", prNumber: 1, userId: "u" })).rejects.toThrow(
      /検査の失敗/,
    );
    expect(triggerCalls).toBe(0);
  });

  it("巡回でdevelop向けのopenなPRへ写し、合否が決まったPRは間隔をあけて照合する", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), "success")];
    await expect(gateService.sweepCiGateMirror()).resolves.toEqual({ checked: 1, errors: 0 });
    expect(statuses).toEqual([{ sha: HEAD, state: "success" }]);
    await expect(gateService.sweepCiGateMirror()).resolves.toEqual({ checked: 0, errors: 0 });
    await expect(gateService.sweepCiGateMirror(new Date(Date.now() + 5 * 60 * 1000))).resolves.toEqual({
      checked: 1,
      errors: 0,
    });
  });

  it("写す設定が無いリポジトリは巡回しない", async () => {
    settings.set("o/r", { ...settings.get("o/r")!, mirrorActionsToCiGate: false });
    actionsRuns = [actionsRun(10, minutesAgo(5), "success")];
    await expect(gateService.sweepCiGateMirror()).resolves.toEqual({ checked: 0, errors: 0 });
    expect(statuses).toHaveLength(0);
  });

  it("workflow_runのWebhookで、ci.ymlが動いたPRをすぐ決め直す", async () => {
    actionsRuns = [actionsRun(10, minutesAgo(5), "success")];
    const payload = {
      repository: { full_name: "o/r" },
      workflow_run: { path: ".github/workflows/ci.yml", event: "pull_request", pull_requests: [{ number: 1, base: { ref: "develop" } }] },
    };
    await expect(gateService.handleWorkflowRunEventForCiGate(payload)).resolves.toBe(1);
    expect(statuses).toEqual([{ sha: HEAD, state: "success" }]);
    await expect(
      gateService.handleWorkflowRunEventForCiGate({ ...payload, workflow_run: { ...payload.workflow_run, path: ".github/workflows/x.yml" } }),
    ).resolves.toBe(0);
  });
});
