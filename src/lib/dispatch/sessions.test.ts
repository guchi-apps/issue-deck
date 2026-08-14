import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
const escalateFailedSession = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchSession: {
      get findMany() {
        return findMany;
      },
      get upsert() {
        return upsert;
      },
      get updateMany() {
        return updateMany;
      },
      get deleteMany() {
        return deleteMany;
      },
    },
  },
}));

vi.mock("@/lib/dispatch/session-escalation", () => ({
  get escalateFailedSession() {
    return escalateFailedSession;
  },
}));

const { reportDispatchSessions } = await import("./sessions");

const NOW = new Date("2026-08-14T12:00:00.000Z");

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1217",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1217,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: NOW,
    lastReportedAt: NOW,
    escalatedState: null,
    escalatedAt: null,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    tmuxSessionName: "issue-deck-issue-1217",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1217,
    paneDead: false,
    paneDeadStatus: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 1回目は既存行の取得、2回目は保存後の読み直し
  findMany.mockResolvedValue([]);
  escalateFailedSession.mockResolvedValue(true);
});

describe("reportDispatchSessions", () => {
  it("報告に含まれない既存行をGONEへ倒す（削除はしない）", async () => {
    findMany
      .mockResolvedValueOnce([
        existingRow(),
        existingRow({ id: "row-2", tmuxSessionName: "dayspan-issue-5" }),
      ])
      .mockResolvedValueOnce([]);

    await reportDispatchSessions({
      hostName: "subpc",
      sessions: [report()],
      now: NOW,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          host: "subpc",
          tmuxSessionName: { in: ["dayspan-issue-5"] },
        }),
        data: expect.objectContaining({ state: "GONE" }),
      }),
    );
  });

  it("既にGONEの行は繰り返し更新しない", async () => {
    findMany
      .mockResolvedValueOnce([existingRow({ state: "GONE" })])
      .mockResolvedValueOnce([]);

    await reportDispatchSessions({ hostName: "subpc", sessions: [], now: NOW });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("GONEにする際は引き上げの記録も落とす（同名で起動し直して再び落ちたときに拾えるように）", async () => {
    findMany
      .mockResolvedValueOnce([existingRow({ state: "FAILED", escalatedState: "FAILED" })])
      .mockResolvedValueOnce([]);

    await reportDispatchSessions({ hostName: "subpc", sessions: [], now: NOW });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "GONE", escalatedState: null }),
      }),
    );
  });

  it("異常終了で引き上げる", async () => {
    findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

    const result = await reportDispatchSessions({
      hostName: "subpc",
      sessions: [report({ paneDead: true, paneDeadStatus: 3 })],
      now: NOW,
    });

    expect(escalateFailedSession).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1217,
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1217",
      exitStatus: 3,
    });
    expect(result.escalated).toBe(1);
  });

  it("異常終了が続く間は引き上げ直さない", async () => {
    findMany
      .mockResolvedValueOnce([
        existingRow({ state: "FAILED", escalatedState: "FAILED", exitStatus: 3 }),
      ])
      .mockResolvedValueOnce([]);

    const result = await reportDispatchSessions({
      hostName: "subpc",
      sessions: [report({ paneDead: true, paneDeadStatus: 3 })],
      now: NOW,
    });

    expect(escalateFailedSession).not.toHaveBeenCalled();
    expect(result.escalated).toBe(0);
  });

  it("正常終了して残っているペインでは引き上げない（tmux 3.2未満では正常終了でも残る）", async () => {
    findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

    const result = await reportDispatchSessions({
      hostName: "subpc",
      sessions: [report({ paneDead: true, paneDeadStatus: 0 })],
      now: NOW,
    });

    expect(escalateFailedSession).not.toHaveBeenCalled();
    expect(result.escalated).toBe(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ state: "EXITED" }),
      }),
    );
  });

  it("引き上げに失敗しても例外を投げない", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    escalateFailedSession.mockResolvedValue(false);

    const result = await reportDispatchSessions({
      hostName: "subpc",
      sessions: [report({ paneDead: true, paneDeadStatus: 1 })],
      now: NOW,
    });

    expect(result.escalated).toBe(0);
  });

  it("別ホストの行には触らない", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await reportDispatchSessions({ hostName: "subpc", sessions: [], now: NOW });

    expect(findMany).toHaveBeenNthCalledWith(1, { where: { host: "subpc" } });
  });
});
