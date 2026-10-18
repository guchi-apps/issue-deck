import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  remoteSession: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  dispatchHost: { findMany: vi.fn(), findUnique: vi.fn() },
  dispatchJob: { findMany: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

import { enqueueRemoteSessionKill, listRemoteSessions } from "./remote-session";

describe("リモートセッションの利用者境界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.remoteSession.findMany.mockResolvedValue([]);
    db.remoteSession.groupBy.mockResolvedValue([]);
    db.dispatchHost.findMany.mockResolvedValue([]);
    db.dispatchJob.findMany.mockResolvedValue([]);
  });

  it("一覧は要求者のセッションだけをwhereで絞る", async () => {
    await listRemoteSessions("u1");
    // 1回目は settleStartingSessions、2回目が一覧
    const listCall = db.remoteSession.findMany.mock.calls.find((c) => c[0]?.orderBy);
    expect(listCall?.[0].where.requestedByUserId).toBe("u1");
  });

  it("終了は要求者のセッションに限り、他人のIDはnot_foundでジョブを積まない", async () => {
    db.remoteSession.findFirst.mockResolvedValue(null);
    const result = await enqueueRemoteSessionKill({ id: "s1", requestedByUserId: "u2" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(db.remoteSession.findFirst).toHaveBeenCalledWith({
      where: { id: "s1", requestedByUserId: "u2" },
    });
    expect(db.dispatchJob.create).not.toHaveBeenCalled();
  });
});
