import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

// メモリ上の簡易DB。where（等値・in・lt・not・OR）と更新（increment）だけを再現する
const store = vi.hoisted(() => {
  const tables: Record<string, Row[]> = { parentRun: [], parentRunChild: [], executionPlan: [] };
  let seq = 0;
  const matchValue = (value: unknown, cond: unknown): boolean => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("lt" in c) return value != null && (value as Date) < (c.lt as Date);
      if ("not" in c) return c.not === null ? value !== null : value !== c.not;
      return false;
    }
    return value === cond;
  };
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, cond]) => {
      if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
      return matchValue(row[k], cond);
    });
  };
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = (row[k] as number) + ((v as Row).increment as number);
      else row[k] = v;
    }
    row.updatedAt = new Date();
  };
  const table = (name: string, defaults: () => Row = () => ({})) => ({
    findMany: async ({ where }: { where?: Row } = {}) => tables[name].filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => tables[name].filter((r) => matches(r, where)).at(-1) ?? null,
    findUnique: async ({ where }: { where: Row }) => tables[name].find((r) => matches(r, where)) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      apply(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const rows = tables[name].filter((r) => matches(r, where));
      rows.forEach((r) => apply(r, data));
      return { count: rows.length };
    },
    create: async ({ data }: { data: Row }) => {
      const { children, ...rest } = data;
      if (rest.activeKey != null && tables[name].some((r) => r.activeKey === rest.activeKey)) throw new Error("unique");
      const row: Row = { id: `${name}-${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...rest };
      tables[name].push(row);
      if (children) {
        for (const c of (children as { create: Row[] }).create) {
          tables.parentRunChild.push({ id: `c-${++seq}`, runId: row.id, launchState: "PENDING", attempt: 1, jobId: null, verifiedAt: null, display: null, lastError: null, updatedAt: new Date(), ...c });
        }
      }
      return row;
    },
  });
  return { tables, table, reset: () => { for (const k of Object.keys(tables)) tables[k] = []; seq = 0; } };
});

vi.mock("@/lib/db", () => {
  const parentRun = store.table("parentRun", () => ({ status: "RUNNING", verifiedAt: null, notice: null, summary: null, lastSweepAt: null }));
  const include = (row: Row | null, args?: { include?: { children?: boolean } }) =>
    row && args?.include?.children ? { ...row, children: store.tables.parentRunChild.filter((c) => c.runId === row.id) } : row;
  const db = {
    parentRun: {
      ...parentRun,
      findFirst: async (a: { where?: Row; include?: { children?: boolean } }) => include(await parentRun.findFirst(a), a),
      findUnique: async (a: { where: Row; include?: { children?: boolean } }) => include(await parentRun.findUnique(a), a),
      findUniqueOrThrow: async (a: { where: Row; include?: { children?: boolean } }) => include(await parentRun.findUnique(a), a),
    },
    parentRunChild: store.table("parentRunChild"),
    executionPlan: store.table("executionPlan"),
    issue: { findFirst: async () => null },
    dispatchJob: { findUnique: async () => null },
    dispatchSession: { findFirst: async () => null },
    $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (t: unknown) => unknown)(db) : Promise.all(arg as Promise<unknown>[])),
  };
  return { db };
});

vi.mock("@/lib/execution-plan/register", async (orig) => {
  const actual = await orig<typeof import("@/lib/execution-plan/register")>();
  return { ...actual, getPlanView: vi.fn() };
});

import { getPlanView } from "@/lib/execution-plan/register";
import type { PlanSnapshot } from "@/lib/execution-plan/types";
import { applyRunAction, runParentRunSweep, startParentRun, type Deps } from "@/lib/parent-run/run";

const R = "guchi-apps/issue-deck";
const parent = { repository: R, number: 100 };
const plan: PlanSnapshot = {
  objective: "o",
  completionCriteria: ["c"],
  children: [
    { repository: R, number: 1, dependsOn: [] },
    { repository: R, number: 2, dependsOn: [{ repository: R, number: 1, conditions: ["merged"] }] },
  ],
};

type PrState = { kind: "none" } | { kind: "one"; number: number };
let prs: Record<number, PrState>;
let merged: Set<number>;
const enqueue = vi.fn();

function deps(): Deps {
  return {
    verify: {
      tokenFor: async () => "t",
      issueState: async () => "open",
      branchPrs: async (ref) => prs[ref.number] ?? { kind: "none" },
      subIssues: async () => [],
    },
    observePr: async (ref) => ({ merged: merged.has(ref.number), inProduction: false }),
    enqueue: enqueue as unknown as Deps["enqueue"],
    now: () => new Date(),
  };
}

const start = (d = deps()) => startParentRun({ parent, userId: "u", hostName: "subpc", agent: "claude" }, d);
const childState = (n: number) => store.tables.parentRunChild.find((c) => c.number === n)?.launchState;

beforeEach(() => {
  store.reset();
  prs = {};
  merged = new Set();
  enqueue.mockReset();
  enqueue.mockImplementation(async (p: { issueNumber: number }) => ({ ok: true, job: { id: `job-${p.issueNumber}` } }));
  vi.mocked(getPlanView).mockResolvedValue({
    parent,
    currentVersion: 1,
    boundVersion: null,
    plan,
    stages: [],
    versions: [],
  });
});

describe("親Issueの自動実行", () => {
  it("開始で前提のない子だけを起動し、後続は待つ", async () => {
    const r = await start();
    expect(r.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ issueNumber: 1, hostName: "subpc", requestedByUserId: "u" });
    expect(childState(1)).toBe("LAUNCHED");
    expect(childState(2)).toBe("PENDING");
  });

  it("連打しても実行は1件で、同じ子を二重に起動しない", async () => {
    await start();
    const second = await start();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);
    expect(store.tables.parentRun).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("巡回が競合しても1回だけ起動する（lastSweepAtの間隔）", async () => {
    await start();
    enqueue.mockClear();
    prs[1] = { kind: "one", number: 10 };
    merged.add(10);
    store.tables.parentRun[0].lastSweepAt = null;
    await Promise.all([runParentRunSweep(deps()), runParentRunSweep(deps())]);
    const launched2 = enqueue.mock.calls.filter((c) => c[0].issueNumber === 2);
    expect(launched2).toHaveLength(1);
    expect(childState(2)).toBe("LAUNCHED");
  });

  it("Aのマージ後にBが起動し、再起動（取り残されたLAUNCHING）でも二重起動しない", async () => {
    await start();
    prs[1] = { kind: "one", number: 10 };
    merged.add(10);
    // 再起動で取り残された起動受付中を再現する
    const child2 = store.tables.parentRunChild.find((c) => c.number === 2) as Record<string, unknown>;
    child2.launchState = "LAUNCHING";
    child2.updatedAt = new Date(Date.now() - 10 * 60 * 1000);
    store.tables.parentRun[0].lastSweepAt = null;
    enqueue.mockImplementation(async () => ({ ok: false, rejection: "already_queued", message: "既に積まれています" }));
    await runParentRunSweep(deps());
    expect(childState(2)).toBe("LAUNCHED");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 2 }));
  });

  it("一時停止中は未起動の子を起動せず、再開で残りから続ける", async () => {
    await start();
    prs[1] = { kind: "one", number: 10 };
    merged.add(10);
    await applyRunAction(parent, { type: "pause" }, deps());
    store.tables.parentRun[0].lastSweepAt = null;
    enqueue.mockClear();
    await runParentRunSweep(deps());
    expect(enqueue).not.toHaveBeenCalled();
    expect(childState(2)).toBe("PENDING");
    await applyRunAction(parent, { type: "resume" }, deps());
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(childState(2)).toBe("LAUNCHED");
  });

  it("停止すると未起動の子は起動対象から外れ、起動済みの子には触れない", async () => {
    await start();
    const r = await applyRunAction(parent, { type: "stop" }, deps());
    expect(r.ok).toBe(true);
    expect(childState(1)).toBe("LAUNCHED");
    expect(childState(2)).toBe("SKIPPED");
    expect(store.tables.parentRun[0].activeKey).toBeNull();
  });

  it("実行先の問題（ホスト不在など）は起動失敗にせず待機し、回復後に再試行する", async () => {
    enqueue.mockImplementation(async () => ({ ok: false, rejection: "host_offline", message: "ホストがオフラインです" }));
    await start();
    expect(childState(1)).toBe("PENDING");
    const display = store.tables.parentRunChild.find((c) => c.number === 1)?.display as { label: string };
    expect(display.label).toBe("待機（実行先）");
    enqueue.mockImplementation(async (p: { issueNumber: number }) => ({ ok: true, job: { id: `job-${p.issueNumber}` } }));
    store.tables.parentRun[0].lastSweepAt = null;
    await runParentRunSweep(deps());
    expect(childState(1)).toBe("LAUNCHED");
  });

  it("起動できなかった子は再試行で試行番号を進めて取り直し、開始時の対象外は再試行できない", async () => {
    enqueue.mockImplementation(async () => ({ ok: false, rejection: "repository_not_runnable", message: "実行できないリポジトリです" }));
    await start();
    expect(childState(1)).toBe("LAUNCH_FAILED");
    enqueue.mockImplementation(async (p: { issueNumber: number }) => ({ ok: true, job: { id: `job-${p.issueNumber}` } }));
    const outside = await applyRunAction(parent, { type: "retry", child: { repository: R, number: 99 } }, deps());
    expect(outside.ok).toBe(false);
    const r = await applyRunAction(parent, { type: "retry", child: { repository: R, number: 1 } }, deps());
    expect(r.ok).toBe(true);
    expect(store.tables.parentRunChild.find((c) => c.number === 1)?.attempt).toBe(2);
    expect(childState(1)).toBe("LAUNCHED");
  });

  it("子がマージされても、本番反映と本番確認が残れば親は完了しない", async () => {
    await start();
    prs = { 1: { kind: "one", number: 10 }, 2: { kind: "one", number: 11 } };
    merged = new Set([10, 11]);
    store.tables.parentRun[0].lastSweepAt = null;
    await runParentRunSweep(deps());
    const run = store.tables.parentRun[0];
    expect((run.summary as { counts: { done: number }; complete: boolean }).counts.done).toBe(2);
    expect((run.summary as { complete: boolean }).complete).toBe(false);
    expect(run.status).toBe("RUNNING");
  });
});
