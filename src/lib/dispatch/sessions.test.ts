import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
const escalateFailedSession = vi.fn();
const escalateNotStartedSession = vi.fn();
const resolveNotStartedSession = vi.fn();
const postSessionWrapupComment = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchSession: {
      get findMany() {
        return findMany;
      },
      get findUnique() {
        return findUnique;
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
  get escalateNotStartedSession() {
    return escalateNotStartedSession;
  },
  get resolveNotStartedSession() {
    return resolveNotStartedSession;
  },
}));

vi.mock("@/lib/dispatch/session-wrapup", () => ({
  get postSessionWrapupComment() {
    return postSessionWrapupComment;
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
  findUnique.mockResolvedValue(existingRow());
  escalateFailedSession.mockResolvedValue(true);
  escalateNotStartedSession.mockResolvedValue(true);
  resolveNotStartedSession.mockResolvedValue(true);
  postSessionWrapupComment.mockResolvedValue(false);
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

  /**
   * #1119。`SIGKILL`・ホストの再起動で`trap`（`markDispatchSessionEnded`）を通らなかった
   * セッションを、ここで拾う。**報告に含まれていた行は締めない**（まだ生きている）。
   */
  it("報告から消えた行についてだけ締めコメントを試みる", async () => {
    findMany
      .mockResolvedValueOnce([
        existingRow(),
        existingRow({ id: "row-2", tmuxSessionName: "dayspan-issue-5", issueNumber: 5 }),
      ])
      .mockResolvedValueOnce([]);

    await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

    expect(postSessionWrapupComment).toHaveBeenCalledTimes(1);
    expect(postSessionWrapupComment).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxSessionName: "dayspan-issue-5", issueNumber: 5 }),
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

    // #1817。前のセッションに出ていた「あと3分」が、起動し直した直後の別の
    // セッションにそのまま出るのを防ぐ（古いpollerで予定が報告されない場合も含む）
    it("前のセッションの畳む予定を捨てる", async () => {
      findMany
        .mockResolvedValueOnce([
          existingRow({ state: "GONE", reapAt: NOW, reapReason: "PR_MERGED" }),
        ])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({
        reapAt: null,
        reapReason: null,
      });
    });
  });

  /**
   * #1817。畳む予定は毎巡の報告に載るので、**送ってきた値でそのまま置き換える**。
   * 条件を満たさなくなったセッションに終了予告が残ると、いつまでも終わらない予告になる。
   */
  describe("畳む予定（#1817）", () => {
    it("報告された予定をそのまま保存する", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

      await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ reapAt: "2026-08-14T12:05:00.000Z", reapReason: "PR_MERGED" })],
        now: NOW,
      });

      expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({
        reapAt: new Date("2026-08-14T12:05:00.000Z"),
        reapReason: "PR_MERGED",
      });
    });

    it("予定が無い報告（null）で、前の巡の予定を消す", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ reapAt: NOW, reapReason: "PR_MERGED" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ reapAt: null, reapReason: null })],
        now: NOW,
      });

      expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({
        reapAt: null,
        reapReason: null,
      });
    });

    it("Codexのセッションの宛先を、送ってきた巡の値で置き換える（#2519）", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

      await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ codexThreadKnown: false })],
        now: NOW,
      });

      expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({ codexThreadKnown: false });
    });

    // 古いpollerはこの項目を送ってこない。**キーごと渡さない**ので既存の値が消えない
    it("宛先を申告しない古いpollerでは、その列を書き換えない（#2519）", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("codexThreadKnown");
    });

    it("項目を送ってこない古いpollerでは既存の値を触らない", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("reapAt");
    });
  });

  /**
   * #1465。フォルダの信頼確認で止まっている間はフックが1つも飛ばないため、pollerが持ち込む
   * `claudeStarting`だけが判断材料になる。**入り直さない**ことが、毎分コメントが増えないことの担保。
   */
  describe("Claude Codeが開始していないセッション（#1465）", () => {
    it("NOT_STARTEDを立て、Issueへ知らせて00.check-userを付ける", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);

      const result = await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ claudeStarting: true })],
        now: NOW,
      });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ activity: "NOT_STARTED", activityAt: NOW }),
        }),
      );
      expect(escalateNotStartedSession).toHaveBeenCalledWith(
        expect.objectContaining({ tmuxSessionName: "issue-deck-issue-1217", issueNumber: 1217 }),
      );
      expect(result.escalated).toBe(1);
    });

    it("同じ報告が続く間は知らせ直さない", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ activity: "NOT_STARTED" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ claudeStarting: true })],
        now: NOW,
      });

      expect(escalateNotStartedSession).not.toHaveBeenCalled();
      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("activity");
    });

    it("人が答えて開始したら、様子を戻して00.check-userを外す", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ activity: "NOT_STARTED" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ claudeStarting: false })],
        now: NOW,
      });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ activity: null, activityAt: null }),
        }),
      );
      expect(resolveNotStartedSession).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 1217 }),
      );
    });

    it("報告しないpoller（古いホスト）では何もしない", async () => {
      findMany
        .mockResolvedValueOnce([existingRow({ activity: "NOT_STARTED" })])
        .mockResolvedValueOnce([]);

      await reportDispatchSessions({ hostName: "subpc", sessions: [report()], now: NOW });

      expect(escalateNotStartedSession).not.toHaveBeenCalled();
      expect(resolveNotStartedSession).not.toHaveBeenCalled();
      expect(upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("activity");
    });

    it("知らせられなくても件数に数えないだけで、報告そのものは成功する", async () => {
      findMany.mockResolvedValueOnce([existingRow()]).mockResolvedValueOnce([]);
      escalateNotStartedSession.mockResolvedValue(false);

      const result = await reportDispatchSessions({
        hostName: "subpc",
        sessions: [report({ claudeStarting: true })],
        now: NOW,
      });

      expect(result.escalated).toBe(0);
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
    findUnique.mockResolvedValue(null);
    const result = await markDispatchSessionEnded({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1321",
      now: NOW,
    });
    expect(result).toEqual({ updated: 0 });
  });

  /**
   * #1119。何も記録を残さずに終わったセッションを締める。投稿するかどうか（記録が残っているか）の
   * 判定は`session-wrapup.ts`側なので、ここでは「呼ぶ／呼ばない」だけを見る。
   */
  it("ALIVEから倒したときに締めコメントを試みる", async () => {
    await markDispatchSessionEnded({
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1217",
      now: NOW,
    });
    expect(postSessionWrapupComment).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1217,
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1217",
      firstSeenAt: NOW,
      now: NOW,
    });
  });

  // 二重に報告された2回目は0件になる。ここで締めるとGitHubへの往復だけが増える
  it("既にGONEなら締めコメントを試みない", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await markDispatchSessionEnded({ hostName: "subpc", tmuxSessionName: "s", now: NOW });
    expect(postSessionWrapupComment).not.toHaveBeenCalled();
  });
});
