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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  runs.length = 0;
  deliveries.clear();
  settings.clear();
  statuses.length = 0;
  triggerCalls = 0;
  pr = { headSha: HEAD, baseSha: BASE, state: "open" };
  workflowStatus = "success";
  resultOverrides = {};
  settings.set("o/r", {
    id: "o/r",
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
