import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const rows: Row[] = [];
const jobs = new Map<string, { status: string }>();
let seq = 0;

function copy(row: Row | null): Row | null {
  return row ? { ...row } : null;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return c.not === null ? value != null : value !== c.not;
      if ("lt" in c) return value != null && (value as Date) < (c.lt as Date);
    }
    return value === (cond ?? null) || (cond === null && value == null);
  });
}

vi.mock("@/lib/db", () => ({
  db: {
    sessionDependencyWait: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        copy(rows.find((r) => matches(r, where)) ?? null),
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `w${(seq += 1)}`, createdAt: new Date(), updatedAt: new Date(), ...data } as Row;
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    dispatchJob: { findUnique: async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null },
  },
}));

const enqueue = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({ enqueueSessionControlJob: (...a: unknown[]) => enqueue(...a) }));
const findSession = vi.fn();
vi.mock("@/lib/dispatch/sessions", () => ({ findDispatchSessionForIssue: (...a: unknown[]) => findSession(...a) }));
vi.mock("@/lib/dispatch/installation-token", () => ({ resolveInstallationToken: async () => "tok" }));
const createComment = vi.fn(async () => ({}));
vi.mock("@/lib/github/issues-api", () => ({ createComment: () => createComment(), fetchIssueState: vi.fn() }));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequest: vi.fn() }));
vi.mock("@/lib/dispatch/check-user-labels", () => ({ addCheckUserWithReason: vi.fn(async () => []) }));

import {
  advanceDependencyWait,
  registerDependencyWait,
  runDependencyWaitSweep,
} from "@/lib/dispatch/dependency-wait-run";
import type { DependencyObservation, DependencyRef } from "@/lib/dispatch/dependency-wait";

const issueDep: DependencyRef = { repository: "guchi-apps/aide", number: 614, kind: "issue" };
const target = { repositoryFullName: "guchi-apps/asset-manager", issueNumber: 687 };

function depsWith(observation: DependencyObservation | Error, at = new Date("2026-10-10T12:00:00Z")) {
  return {
    observe: async () => {
      if (observation instanceof Error) throw observation;
      return observation;
    },
    now: () => at,
  };
}
const open: DependencyObservation = { state: "open", merged: null, baseRef: null, inProduction: null };
const closed: DependencyObservation = { state: "closed", merged: null, baseRef: null, inProduction: null };

beforeEach(() => {
  rows.length = 0;
  jobs.clear();
  seq = 0;
  enqueue.mockReset();
  createComment.mockClear();
  findSession.mockReset();
  findSession.mockResolvedValue({ host: "subpc", state: "ALIVE", activity: "RESPONDED", activityAt: null });
  enqueue.mockResolvedValue({ ok: true, job: { id: "job1" } });
});

const register = (conditions: ("closed" | "released")[], observation: DependencyObservation | Error) =>
  registerDependencyWait(
    { ...target, dependency: issueDep, conditions, reason: "aide#614待ち", source: "session" },
    depsWith(observation),
  );

describe("registerDependencyWait", () => {
  it("未成立なら待機を維持し、指示は積まない", async () => {
    const view = await register(["closed"], open);
    expect(view.status).toBe("WAITING");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("登録時点で成立済みなら、古い情報で待たずにそのまま再開を要求する", async () => {
    const view = await register(["closed"], closed);
    expect(view.status).toBe("RESUME_REQUESTED");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("クローズだけでは本番反映まで済んだとみなさず、人の確認へ回す", async () => {
    const view = await register(["closed", "released"], closed);
    expect(view.status).toBe("NEEDS_CONFIRM");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("同じIssueの二重登録は1行にまとめる", async () => {
    await register(["closed"], open);
    await register(["closed"], open);
    expect(rows).toHaveLength(1);
  });

  it("取得に失敗しても待機は維持し、理由を残す", async () => {
    const view = await register(["closed"], new Error("接続できません"));
    expect(view.status).toBe("WAITING");
    expect(view.lastError).toContain("接続できません");
  });
});

describe("再開の追跡", () => {
  it("送信しただけでは再開済みにせず、動き出しを確認して初めてRESUMEDにする", async () => {
    await register(["closed"], closed);
    const id = rows[0].id;
    jobs.set("job1", { status: "SUCCEEDED" });
    const sent = await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    expect(sent?.status).toBe("RESUME_SENT");

    // まだ動き出していない
    const same = await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    expect(same?.status).toBe("RESUME_SENT");

    findSession.mockResolvedValue({
      host: "subpc",
      state: "ALIVE",
      activity: "WORKING",
      activityAt: "2026-10-10T12:00:30Z",
    });
    const resumed = await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T12:01:00Z")));
    expect(resumed?.status).toBe("RESUMED");
    expect(rows[0].activeKey).toBeNull();
  });

  it("送信後に動き出さなければ失敗として理由付きで残す", async () => {
    await register(["closed"], closed);
    jobs.set("job1", { status: "SUCCEEDED" });
    const id = rows[0].id;
    await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    const failed = await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    expect(failed?.status).toBe("RESUME_FAILED");
    expect(failed?.failureReason).toContain("確認できませんでした");
  });

  it("セッションが終了していれば、待ちの記録を残したまま復旧を案内する", async () => {
    findSession.mockResolvedValue({ host: "subpc", state: "GONE", activity: null, activityAt: null });
    const view = await register(["closed"], closed);
    expect(view.status).toBe("RESUME_FAILED");
    expect(view.failureReason).toContain("復旧");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("指示の積み込みに失敗したら理由付きで失敗にする", async () => {
    enqueue.mockResolvedValue({ ok: false, rejection: "x", message: "ホストが応答していません" });
    const view = await register(["closed"], closed);
    expect(view.status).toBe("RESUME_FAILED");
    expect(view.failureReason).toBe("ホストが応答していません");
  });

  it("巡回と手動操作が重なっても指示は1回しか積まない", async () => {
    await register(["closed"], open);
    const id = rows[0].id;
    await Promise.all([
      advanceDependencyWait(id, { manual: false }, depsWith(closed)),
      advanceDependencyWait(id, { manual: true, userId: "u1" }, depsWith(closed)),
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("失敗の通知は同じ理由で繰り返さない", async () => {
    findSession.mockResolvedValue(null);
    await register(["closed"], closed);
    const before = createComment.mock.calls.length;
    await advanceDependencyWait(rows[0].id, { manual: true, userId: "u1" }, depsWith(closed));
    await advanceDependencyWait(rows[0].id, { manual: true, userId: "u1" }, depsWith(closed));
    expect(createComment.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});

describe("runDependencyWaitSweep", () => {
  it("巡回で登録後の成立を拾って再開する", async () => {
    await register(["closed"], open);
    const result = await runDependencyWaitSweep(depsWith(closed));
    expect(result.actions).toEqual([{ id: rows[0].id, status: "RESUME_REQUESTED" }]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("短い間隔の重複巡回は評価し直さない", async () => {
    await register(["closed"], open);
    await runDependencyWaitSweep(depsWith(open));
    const second = await runDependencyWaitSweep(depsWith(closed, new Date("2026-10-10T12:00:10Z")));
    expect(second.actions).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("失敗した待ちは自動では蒸し返さない", async () => {
    findSession.mockResolvedValue(null);
    await register(["closed"], closed);
    enqueue.mockClear();
    findSession.mockResolvedValue({ host: "subpc", state: "ALIVE", activity: null, activityAt: null });
    await runDependencyWaitSweep(depsWith(closed, new Date("2026-10-10T14:00:00Z")));
    expect(enqueue).not.toHaveBeenCalled();
  });
});
