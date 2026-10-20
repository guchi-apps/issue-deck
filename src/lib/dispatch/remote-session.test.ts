import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  remoteSession: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  dispatchHost: { findMany: vi.fn(), findUnique: vi.fn() },
  repository: { findMany: vi.fn(), findFirst: vi.fn() },
  dispatchJob: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

import {
  enqueueRemoteSessionKill,
  enqueueRemoteSessionResume,
  listRemoteSessions,
  syncRemoteSessionsFromHost,
} from "./remote-session";
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

  it("再開を積んだ直後（starting）は、自動終了の記録に名前が残っていてもendedへ戻さない（#4874）", async () => {
    db.remoteSession.findMany.mockResolvedValue([{ ...row("car-care-remote-r4wiv8se"), status: "starting" }]);
    await syncRemoteSessionsFromHost({
      hostName: "subpc",
      reported: [],
      idleEnded: ["car-care-remote-r4wiv8se"],
      now,
    });
    expect(db.remoteSession.update).not.toHaveBeenCalled();
  });
});

describe("enqueueRemoteSessionResume（#4874）", () => {
  const now = new Date("2026-10-20T03:00:00Z");
  const ended = {
    id: "s1",
    repositoryFullName: "me/app",
    host: "subpc",
    tmuxSessionName: "app-remote-r4wiv8se",
    status: "ended",
    remoteControlUrl: "https://claude.ai/code/session_old",
    failureMessage: "一定時間操作が無かったため、自動で終了しました。",
    lastSeenAt: new Date("2026-10-19T20:00:00Z"),
    createdAt: new Date("2026-10-19T17:00:00Z"),
  };
  const host = (agentVersion: string) => ({
    name: "subpc",
    lastSeenAt: now,
    remoteSessionCapable: true,
    agentVersion,
    repositories: JSON.stringify(["me/app"]),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.remoteSession.findFirst.mockResolvedValue(ended);
    db.repository.findFirst.mockResolvedValue({ id: "r1" });
    db.remoteSession.findMany.mockResolvedValue([]);
    db.remoteSession.groupBy.mockResolvedValue([]);
    db.dispatchHost.findMany.mockResolvedValue([host("41")]);
    db.dispatchJob.create.mockResolvedValue({ id: "job2" });
    db.remoteSession.updateMany.mockResolvedValue({ count: 1 });
    db.remoteSession.findUnique.mockResolvedValue({ ...ended, status: "starting", remoteControlUrl: null });
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  });

  it("同じ行と同じtmux名のまま、startingへ戻して起動ジョブを積む（古いURLは消す）", async () => {
    const result = await enqueueRemoteSessionResume({ id: "s1", requestedByUserId: "u1", now });
    expect(result).toMatchObject({ ok: true, session: { id: "s1", status: "starting", remoteControlUrl: null } });
    expect(db.dispatchJob.create.mock.calls[0][0].data).toMatchObject({
      kind: "REMOTE_SESSION",
      targetHost: "subpc",
      tmuxSessionName: "app-remote-r4wiv8se",
      activeKey: "remote_session:app-remote-r4wiv8se",
    });
    expect(db.remoteSession.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: { in: ["ended", "failed"] } },
      data: { status: "starting", launchJobId: "job2", remoteControlUrl: null, failureMessage: null, endedAt: null },
    });
  });

  it("一度も動かなかったセッションは再開できない", async () => {
    db.remoteSession.findFirst.mockResolvedValue({ ...ended, status: "failed", lastSeenAt: null });
    const result = await enqueueRemoteSessionResume({ id: "s1", requestedByUserId: "u1", now });
    expect(result).toMatchObject({ ok: false, reason: "not_resumable" });
    expect(db.dispatchJob.create).not.toHaveBeenCalled();
  });

  it("再開に対応していない古いpollerへは配らない", async () => {
    db.dispatchHost.findMany.mockResolvedValue([host("40")]);
    const result = await enqueueRemoteSessionResume({ id: "s1", requestedByUserId: "u1", now });
    expect(result).toMatchObject({ ok: false, reason: "resume_unsupported" });
    expect(db.dispatchJob.create).not.toHaveBeenCalled();
  });

  it("同時実行の上限に達していれば断る", async () => {
    db.remoteSession.groupBy.mockResolvedValue([{ host: "subpc", _count: { _all: 3 } }]);
    const result = await enqueueRemoteSessionResume({ id: "s1", requestedByUserId: "u1", now });
    expect(result).toMatchObject({ ok: false, reason: "limit_reached" });
  });

  it("別の再開が先に通っていればalready_queued", async () => {
    db.remoteSession.updateMany.mockResolvedValue({ count: 0 });
    const result = await enqueueRemoteSessionResume({ id: "s1", requestedByUserId: "u1", now });
    expect(result).toMatchObject({ ok: false, reason: "already_queued" });
  });
});
