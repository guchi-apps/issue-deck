import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  remoteSession: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  dispatchHost: { findMany: vi.fn(), findUnique: vi.fn() },
  repository: { findMany: vi.fn(), findFirst: vi.fn() },
  dispatchJob: { findMany: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

import { enqueueRemoteSessionKill, listRemoteSessions, syncRemoteSessionsFromHost } from "./remote-session";
import { REMOTE_SESSION_IDLE_ENDED_MESSAGE } from "./remote-session-rules";

describe("リモートセッションの利用者境界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.remoteSession.findMany.mockResolvedValue([]);
    db.remoteSession.groupBy.mockResolvedValue([]);
    db.dispatchHost.findMany.mockResolvedValue([]);
    db.dispatchJob.findMany.mockResolvedValue([]);
    db.repository.findMany.mockResolvedValue([]);
  });

  it("一覧は要求者のセッションだけをwhereで絞る", async () => {
    await listRemoteSessions("u1");
    // 1回目は settleStartingSessions、2回目が一覧
    const listCall = db.remoteSession.findMany.mock.calls.find((c) => c[0]?.orderBy);
    expect(listCall?.[0].where.requestedByUserId).toBe("u1");
  });

  it("一覧は現在連携しているリポジトリのセッションだけに絞る（連携解除後は返さない）", async () => {
    db.repository.findMany.mockResolvedValue([{ fullName: "me/app" }]);
    await listRemoteSessions("u1");
    const listCall = db.remoteSession.findMany.mock.calls.find((c) => c[0]?.orderBy);
    expect(listCall?.[0].where.repositoryFullName).toEqual({ in: ["me/app"] });
  });

  it("連携解除後の終了はnot_foundでジョブを積まない", async () => {
    db.remoteSession.findFirst.mockResolvedValue({
      id: "s1", repositoryFullName: "me/app", status: "running", host: "h", tmuxSessionName: "t",
    });
    db.repository.findFirst.mockResolvedValue(null);
    const result = await enqueueRemoteSessionKill({ id: "s1", requestedByUserId: "u1" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(db.repository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: "me/app", installation: { userInstallations: { some: { userId: "u1" } } } },
      }),
    );
    expect(db.dispatchJob.create).not.toHaveBeenCalled();
  });

  it("ホストの登録リポジトリは要求者の連携分だけに絞る", async () => {
    db.dispatchHost.findMany.mockResolvedValue([
      { name: "h", lastSeenAt: new Date(), remoteSessionCapable: true, repositories: JSON.stringify(["me/app", "other/secret"]) },
    ]);
    db.repository.findMany.mockResolvedValue([{ fullName: "me/app" }]);
    const state = await listRemoteSessions("u1");
    expect(state.hosts[0].repositories).toEqual(["me/app"]);
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

describe("syncRemoteSessionsFromHost の自動終了（#4871）", () => {
  const now = new Date("2026-10-19T13:00:00Z");
  const row = (name: string) => ({
    id: name,
    tmuxSessionName: name,
    status: "running",
    remoteControlUrl: null,
    lastSeenAt: new Date(now.getTime() - 30_000),
    updatedAt: now,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("無操作で自動終了した名前は、猶予を待たずに理由付きでendedにする", async () => {
    db.remoteSession.findMany.mockResolvedValue([row("car-care-remote-r4wiv8se"), row("issue-deck-remote-hx36t96g")]);
    await syncRemoteSessionsFromHost({
      hostName: "subpc",
      reported: [],
      idleEnded: ["car-care-remote-r4wiv8se"],
      now,
    });
    // 自動終了したものだけ。もう一方は猶予（3分）内なので触らない
    expect(db.remoteSession.update).toHaveBeenCalledTimes(1);
    expect(db.remoteSession.update).toHaveBeenCalledWith({
      where: { id: "car-care-remote-r4wiv8se" },
      data: { status: "ended", endedAt: now, failureMessage: REMOTE_SESSION_IDLE_ENDED_MESSAGE },
    });
  });

  it("申告にまだ生きているものは、自動終了の記録があってもrunningのまま扱う", async () => {
    db.remoteSession.findMany.mockResolvedValue([row("car-care-remote-r4wiv8se")]);
    await syncRemoteSessionsFromHost({
      hostName: "subpc",
      reported: [{ tmuxSessionName: "car-care-remote-r4wiv8se", remoteControlUrl: null }],
      idleEnded: ["car-care-remote-r4wiv8se"],
      now,
    });
    expect(db.remoteSession.update.mock.calls[0][0].data.status).toBe("running");
  });
});
