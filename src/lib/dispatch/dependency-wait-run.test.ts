import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const rows: Row[] = [];
const jobs = new Map<string, { status: string; message?: string | null; finishedAt?: Date | null; claimedAt?: Date | null; targetHost?: string; tmuxSessionName?: string | null }>();
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
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
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
  cancelDependencyWait,
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
    jobs.set("job1", { status: "SUCCEEDED", targetHost: "subpc", claimedAt: new Date("2026-10-10T12:00:00Z"), finishedAt: new Date("2026-10-10T12:00:05Z") });
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
    jobs.set("job1", { status: "SUCCEEDED", targetHost: "subpc", claimedAt: new Date("2026-10-10T12:00:00Z"), finishedAt: new Date("2026-10-10T12:00:05Z") });
    const id = rows[0].id;
    await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    const failed = await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    expect(failed?.status).toBe("RESUME_FAILED");
    expect(failed?.failureReason).toContain("確認できませんでした");
  });

  it("見送られた理由（未送信入力）をSKIPPEDだけにせず失敗理由へ載せる", async () => {
    await register(["closed"], closed);
    jobs.set("job1", { status: "SKIPPED", message: "入力欄に未送信の文字が残っているため送りませんでした" });
    const failed = await advanceDependencyWait(rows[0].id, { manual: false }, depsWith(closed));
    expect(failed?.status).toBe("RESUME_FAILED");
    expect(failed?.failureReason).toContain("未送信の文字が残");
    expect(failed?.failureReason).not.toBe("SKIPPED");
  });

  it("作業中・承認待ちの見送りは入力欄に触れる退避の対象として扱わない", async () => {
    await register(["closed"], closed);
    jobs.set("job1", { status: "SKIPPED", message: "承認プロンプトまたは選択フォームの表示中のため送りませんでした" });
    const failed = await advanceDependencyWait(rows[0].id, { manual: false }, depsWith(closed));
    expect(failed?.failureReason).toContain("承認プロンプト");
    expect(failed?.failureReason).not.toContain("未送信");
  });

  it("送信待ちのジョブが期限を過ぎても未処理なら、理由付きで止める", async () => {
    await register(["closed"], closed);
    jobs.set("job1", { status: "QUEUED" });
    rows[0].resumeRequestedAt = new Date("2026-10-10T12:00:00Z");
    const failed = await advanceDependencyWait(rows[0].id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    expect(failed?.status).toBe("RESUME_FAILED");
    expect(failed?.failureReason).toContain("期限");
  });

  it("手動の再開で確認済みのときだけ、退避付きで指示を積む", async () => {
    await register(["closed"], closed);
    jobs.set("job1", { status: "SKIPPED", message: "入力欄に未送信の文字が残っているため送りませんでした" });
    const id = rows[0].id;
    await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    expect(enqueue.mock.calls[0][0].stashInput).toBe(false);

    enqueue.mockClear();
    enqueue.mockResolvedValue({ ok: true, job: { id: "job2" } });
    await advanceDependencyWait(id, { manual: true, stashInput: true }, depsWith(closed));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].stashInput).toBe(true);
    expect(enqueue.mock.calls[0][0].instruction).toContain("614");
  });

  it("自動の巡回は退避付きの指示を積まない", async () => {
    await register(["closed"], closed);
    const id = rows[0].id;
    jobs.set("job1", { status: "SKIPPED", message: "入力欄に未送信の文字が残っているため送りませんでした" });
    await advanceDependencyWait(id, { manual: false, stashInput: true }, depsWith(closed));
    // 失敗後に自動では再開しない（人の「作業を再開」を待つ）。stashInputだけ立っていても積まない
    expect(enqueue).toHaveBeenCalledTimes(1);
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


describe("依存再開の活動照合の回帰", () => {
  const sentAt = new Date("2026-10-10T12:00:05Z");
  const checkedAt = new Date("2026-10-10T12:05:00Z");
  async function send() {
    await register(["closed"], closed);
    jobs.set("job1", {
      status: "SUCCEEDED", targetHost: "subpc", tmuxSessionName: "asset-manager-issue-687",
      claimedAt: new Date("2026-10-10T12:00:00Z"), finishedAt: sentAt,
    });
    return rows[0].id;
  }
  function session(overrides: Record<string, unknown> = {}) {
    return { host: "subpc", tmuxSessionName: "asset-manager-issue-687", state: "ALIVE",
      activity: "RESPONDED", activityAt: "2026-10-10T11:59:00Z", stepSeenAt: null, ...overrides };
  }

  it.each([
    { stepSeenAt: "2026-10-10T12:00:30Z" },
    { activity: "RESPONDED", activityAt: "2026-10-10T12:00:30Z" },
    // 送信成功のHTTP報告が届く前にツールが走るケースも拾う
    { stepSeenAt: "2026-10-10T12:00:03Z" },
  ])("巡回前の活動を再開の証拠として扱う: %j", async (activity) => {
    const id = await send();
    findSession.mockResolvedValue(session(activity));
    await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    const view = await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    expect(view?.resumeSentAt).toBe(sentAt.toISOString());
    expect(view?.status).toBe("RESUMED");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stepSeenAt: "2026-10-10T11:59:30Z" },
    { stepSeenAt: "invalid", activityAt: "invalid" },
    { activity: "WAITING_INPUT", activityAt: "2026-10-10T12:01:00Z" },
    { host: "otherpc", stepSeenAt: "2026-10-10T12:01:00Z" },
    { tmuxSessionName: "other-session", stepSeenAt: "2026-10-10T12:01:00Z" },
  ])("再開の証拠ではない活動を採用しない: %j", async (activity) => {
    const id = await send();
    findSession.mockResolvedValue(session(activity));
    await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    const view = await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    expect(view?.status).toBe("RESUME_SENT");
  });

  it("古いジョブIDを消してから再試行し、積み込み中に前の成功を採用しない", async () => {
    const id = await send();
    await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    enqueue.mockImplementationOnce(async () => {
      expect(rows[0].resumeJobId).toBeNull();
      expect(rows[0].resumeSentAt).toBeNull();
      const pending = await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:01Z")));
      expect(pending?.status).toBe("RESUME_REQUESTED");
      return { ok: true, job: { id: "job2" } };
    });
    const view = await advanceDependencyWait(id, { manual: true }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    expect(view?.status).toBe("RESUME_REQUESTED");
    expect(rows[0].resumeJobId).toBe("job2");
  });

  it("活動の取得中に待機が解除されても再開済みへ戻さない", async () => {
    const id = await send();
    await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    findSession.mockImplementationOnce(async () => {
      await cancelDependencyWait(id);
      return session({ activity: "WORKING", activityAt: "2026-10-10T12:06:00Z" });
    });
    const view = await advanceDependencyWait(id, { manual: false }, depsWith(closed, checkedAt));
    expect(view?.status).toBe("CANCELLED");
    expect(rows[0].status).toBe("CANCELLED");
  });
});


describe("依存条件の取得中の競合", () => {
  it("古い観測結果で送信済みの試行を待機へ巻き戻さない", async () => {
    await register(["closed"], open);
    const id = rows[0].id;
    const delayed = {
      ...depsWith(closed),
      observe: async () => {
        await advanceDependencyWait(id, { manual: false }, depsWith(closed));
        return closed;
      },
    };
    const view = await advanceDependencyWait(id, { manual: false }, delayed);
    expect(view?.status).toBe("RESUME_REQUESTED");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rows[0].resumeJobId).toBe("job1");
  });

  it("依存条件の取得中に解除されたら指示を積まない", async () => {
    await register(["closed"], open);
    const id = rows[0].id;
    const cancelled = {
      ...depsWith(closed),
      observe: async () => { await cancelDependencyWait(id); return closed; },
    };
    const view = await advanceDependencyWait(id, { manual: false }, cancelled);
    expect(view?.status).toBe("CANCELLED");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("活動取得中に解除されたらタイムアウト失敗にも戻さない", async () => {
    await register(["closed"], closed);
    const id = rows[0].id;
    jobs.set("job1", { status: "SUCCEEDED", targetHost: "subpc", finishedAt: new Date("2026-10-10T12:00:00Z") });
    await advanceDependencyWait(id, { manual: false }, depsWith(closed));
    createComment.mockClear();
    findSession.mockImplementationOnce(async () => { await cancelDependencyWait(id); return null; });
    const view = await advanceDependencyWait(id, { manual: false }, depsWith(closed, new Date("2026-10-10T13:00:00Z")));
    expect(view?.status).toBe("CANCELLED");
    expect(createComment).not.toHaveBeenCalled();
  });
});
