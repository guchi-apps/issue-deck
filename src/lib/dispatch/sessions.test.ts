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

const { markDispatchSessionEnded, reportDispatchSessions } = await import("./sessions");

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

  /**
   * #1353。行は`(host, tmuxSessionName)`で引き、名前はIssueごとに固定で、消えた行も24時間残す。
   * そのため**同じIssueで起動し直すと前のセッションの行がそのまま再利用される**。
   * 入力待ちのまま畳んだセッションのオレンジのバッジが、次のセッションの起動直後に復活していた。
   */
  describe("同じ名前で立ち上がり直した行（#1353）", () => {
    it("前のセッションが残した入力待ち・Remote ControlのURLを捨てる", async () => {
      findMany
        .mockResolvedValueOnce([
          existingRow({
            state: "GONE",
            activity: "WAITING_INPUT",
            activityAt: new Date("2026-08-14T09:00:00.000Z"),
            remoteControlUrl: "https://claude.ai/code/old",
          }),
        ])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            state: "ALIVE",
            activity: null,
            activityAt: null,
            remoteControlUrl: null,
            firstSeenAt: NOW,
          }),
        }),
      );
    });

    it("プレビューURLは残す（報告は起動時の1回だけで、捨てると二度と載らない）", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ state: "GONE" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("previewUrl");
    });

    it("ALIVEが続いている間は同じセッションなので捨てない", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ state: "ALIVE", activity: "WAITING_INPUT" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("activity");
    });
  });

  it("別ホストの行には触らない", async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await reportDispatchSessions({ hostName: "subpc", sessions: [], now: NOW });

    expect(findMany).toHaveBeenNthCalledWith(1, { where: { host: "subpc" } });
  });
});

/**
 * #1321。セッション自身が畳まれた瞬間に送ってくる1件。**pollerの一括報告を待たずに
 * `ALIVE`を降ろすためだけの入口**で、異常終了の判定はpollerの担当のまま。
 */
describe("markDispatchSessionEnded", () => {
  beforeEach(() => {
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("そのホストのそのセッションだけをGONEへ倒す", async () => {
    const result = await markDispatchSessionEnded({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1321",
      now: NOW,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        host: "subpc",
        tmuxSessionName: "issue-deck-issue-1321",
        // 二重に報告されても2回目は0件。pollerが先にFAILEDを書いていればそれを消さない
        state: "ALIVE",
      },
      data: { state: "GONE", lastReportedAt: NOW, escalatedState: null },
    });
    expect(result).toEqual({ updated: 1 });
  });

  // 同名で起動し直して再び落ちたときに、2回目の引き上げが起きなくなる
  it("引き上げの記録も落とす", async () => {
    await markDispatchSessionEnded({ hostName: "subpc", tmuxSessionName: "s", now: NOW });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ escalatedState: null }) }),
    );
  });

  // pollerがまだ1巡していないなど、対象の行が無いことは普通に起きる
  it("対象の行が無ければ0件を返す（例外にしない）", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const result = await markDispatchSessionEnded({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1321",
      now: NOW,
    });
    expect(result).toEqual({ updated: 0 });
  });
});
