import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchHostFindUnique = vi.fn();
const dispatchSessionFindFirst = vi.fn();
const dispatchJobCreate = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchJobFindUnique = vi.fn();
const dispatchJobUpdateMany = vi.fn();
const dispatchJobCount = vi.fn();
const appSettingFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return appSettingFindUnique;
      },
    },
    dispatchHost: {
      get findUnique() {
        return dispatchHostFindUnique;
      },
    },
    dispatchSession: {
      get findFirst() {
        return dispatchSessionFindFirst;
      },
    },
    dispatchJob: {
      get create() {
        return dispatchJobCreate;
      },
      get findMany() {
        return dispatchJobFindMany;
      },
      get findUnique() {
        return dispatchJobFindUnique;
      },
      get updateMany() {
        return dispatchJobUpdateMany;
      },
      get count() {
        return dispatchJobCount;
      },
    },
  },
}));

// jobs.ts → sessions.ts → session-escalation.ts の連鎖でGitHub Appの環境変数を読みに行く。
// このテストの対象では使わないため、sessions.test.tsと同じように差し替える
vi.mock("@/lib/dispatch/session-escalation", () => ({
  escalateFailedSession: vi.fn(),
}));

const { claimDispatchJobs, enqueueDispatchJob, enqueueSessionControlJob, reportDispatchJob } =
  await import("./jobs");

const NOW = new Date("2026-08-14T12:00:00.000Z");
const REPOSITORY = "guchi-apps/issue-deck";

function host(overrides: Record<string, unknown> = {}) {
  return {
    name: "subpc",
    repositories: JSON.stringify([REPOSITORY]),
    // 生存判定の窓（5分）の内側
    lastSeenAt: new Date(NOW.getTime() - 30_000),
    // セッションの操作（#1332）に対応したpoller
    sessionControlCapable: true,
    maxConcurrency: null,
    ...overrides,
  };
}

function aliveSession(overrides: Record<string, unknown> = {}) {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1311",
    repositoryFullName: REPOSITORY,
    issueNumber: 1311,
    state: "ALIVE",
    ...overrides,
  };
}

async function enqueue() {
  return enqueueDispatchJob({
    repositoryFullName: REPOSITORY,
    issueNumber: 1311,
    hostName: "subpc",
    requestedByUserId: null,
    now: NOW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // expireStaleDispatchJobs が最初に走る。期限切れのジョブは無い前提
  dispatchJobFindMany.mockResolvedValue([]);
  dispatchJobCount.mockResolvedValue(0);
  appSettingFindUnique.mockResolvedValue({ id: 1, dispatchConcurrency: 2 });
  dispatchHostFindUnique.mockResolvedValue(host());
  dispatchSessionFindFirst.mockResolvedValue(null);
  dispatchJobCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "job-1",
    status: "QUEUED",
    message: null,
    tmuxSessionName: null,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    ...data,
  }));
});

/**
 * #1311。**画面側（`resolveDispatchTargetRejection`）だけに置くと、一括投入
 * （`bulk-dispatch-bar.tsx`）が素通りする。** あちらは個々のIssueの判定をAPI側へ委ねている。
 */
describe("enqueueDispatchJob のセッション生存ガード", () => {
  it("セッションが動いていなければ積める", async () => {
    const result = await enqueue();
    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledOnce();
  });

  it("生きているセッションがあれば積まない", async () => {
    dispatchSessionFindFirst.mockResolvedValue(aliveSession());
    const result = await enqueue();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("session_alive");
    // 畳み方が分かるよう、セッション名まで返す
    expect(result.message).toContain("issue-deck-issue-1311");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  // ALIVEに限るのはDBのwhere側で担保している。ここではその条件が外れていないことを見る
  it("探すのはALIVEのセッションだけ", async () => {
    await enqueue();
    expect(dispatchSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryFullName: REPOSITORY, issueNumber: 1311, state: "ALIVE" },
      }),
    );
  });

  // pollerが落ちている間、行はALIVEのまま古びる。判定材料が無いことと「動いている」ことは違う
  it("報告が途絶えたホストのセッションでは止めない", async () => {
    dispatchSessionFindFirst.mockResolvedValue(aliveSession({ host: "deadpc" }));
    dispatchHostFindUnique.mockImplementation(async ({ where }: { where: { name: string } }) =>
      where.name === "subpc"
        ? host()
        : host({ name: "deadpc", lastSeenAt: new Date(NOW.getTime() - 60 * 60 * 1000) }),
    );

    const result = await enqueue();
    expect(result.ok).toBe(true);
  });

  // 各pollerは自分のtmuxしか見ないため、別ホストへの二重起動は向こう側では防げない
  it("別ホストで動いているセッションでも止める", async () => {
    dispatchSessionFindFirst.mockResolvedValue(aliveSession({ host: "otherpc" }));
    dispatchHostFindUnique.mockImplementation(async ({ where }: { where: { name: string } }) =>
      where.name === "subpc" ? host() : host({ name: "otherpc" }),
    );

    const result = await enqueue();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("session_alive");
  });

  // 申告が無い・応答していないホストの判定は従来どおり先に出す
  it("ホストの状態の判定はセッションより先", async () => {
    dispatchHostFindUnique.mockResolvedValue(
      host({ lastSeenAt: new Date(NOW.getTime() - 60 * 60 * 1000) }),
    );
    dispatchSessionFindFirst.mockResolvedValue(aliveSession());

    const result = await enqueue();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("host_offline");
    // ホストで断った時点でセッションは見に行かない
    expect(dispatchSessionFindFirst).not.toHaveBeenCalled();
  });
});

/**
 * #1229。**見送りは失敗でも成功でもない第3の結果。** ただし「終わったジョブ」ではあるので、
 * `activeKey`を外して次を積めるようにする必要がある。
 */
describe("reportDispatchJob の skipped", () => {
  const CLAIMED_JOB = {
    id: "job-1",
    repositoryFullName: REPOSITORY,
    issueNumber: 1229,
    targetHost: "subpc",
    status: "CLAIMED",
    claimedByHost: "subpc",
    message: null,
    tmuxSessionName: null,
    createdAt: NOW,
    claimedAt: NOW,
    startedAt: null,
    finishedAt: null,
  };

  beforeEach(() => {
    dispatchJobFindUnique.mockResolvedValue(CLAIMED_JOB);
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
  });

  async function report(status: "succeeded" | "failed" | "skipped") {
    return reportDispatchJob({
      jobId: "job-1",
      hostName: "subpc",
      status,
      message: "同じIssueのtmuxセッションが既に動いています: issue-deck-issue-1229",
      tmuxSessionName: "issue-deck-issue-1229",
      now: NOW,
    });
  }

  it("SKIPPEDとして終了させ、activeKeyを外す", async () => {
    await report("skipped");

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED",
          finishedAt: NOW,
          // 外さないと同じIssueに次のジョブを積めなくなる
          activeKey: null,
        }),
      }),
    );
  });

  it("失敗・成功の扱いは変わっていない", async () => {
    await report("failed");
    expect(dispatchJobUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );

    await report("succeeded");
    expect(dispatchJobUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
    );
  });

  // 見送ったセッション名を残す。どのセッションのせいで見送られたかが画面から分かる
  it("既に動いていたセッション名を残す", async () => {
    await report("skipped");
    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tmuxSessionName: "issue-deck-issue-1229" }),
      }),
    );
  });
});

/**
 * #1332。走っているセッションへの操作を同じキューに載せる。**起動ジョブとは通す条件が違う**
 * （cloneの有無は問わない代わりに、対象のセッションとpollerの対応が要る）。
 */
describe("enqueueSessionControlJob", () => {
  async function control(kind: "INTERRUPT" | "KILL" = "INTERRUPT") {
    return enqueueSessionControlJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 1332,
      hostName: "subpc",
      kind,
      requestedByUserId: null,
      now: NOW,
    });
  }

  beforeEach(() => {
    dispatchSessionFindFirst.mockResolvedValue(
      aliveSession({ tmuxSessionName: "issue-deck-issue-1332", issueNumber: 1332 }),
    );
  });

  it("生きているセッションがあれば積める", async () => {
    const result = await control();
    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "INTERRUPT",
          status: "QUEUED",
          // 起動ジョブ（`owner/repo#番号`）とぶつからない名前空間
          activeKey: "interrupt:guchi-apps/issue-deck#1332",
          // どのセッションを指した操作か。pollerはこの名前をそのまま使わず突き合わせる
          tmuxSessionName: "issue-deck-issue-1332",
        }),
      }),
    );
  });

  // 古いpollerは`kind`を読まないため、受け取ると起動ジョブとして解釈してセッションを立てる
  it("セッションの操作に対応していないpollerへは積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ sessionControlCapable: null }));
    const result = await control("KILL");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("session_control_unsupported");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("そのホストにセッションの記録が無ければ積まない", async () => {
    dispatchSessionFindFirst.mockResolvedValue(null);
    const result = await control("KILL");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("session_not_found");
  });

  // 終了したペインが残っているセッションは「閉じる」で片付けられる
  it("終了済みのセッションは停止できないが閉じられる", async () => {
    dispatchSessionFindFirst.mockResolvedValue(
      aliveSession({ state: "EXITED", issueNumber: 1332 }),
    );

    const interrupt = await control("INTERRUPT");
    expect(interrupt.ok).toBe(false);
    if (!interrupt.ok) expect(interrupt.rejection).toBe("session_not_alive");

    const kill = await control("KILL");
    expect(kill.ok).toBe(true);
  });

  // スマホでの連打が、そのぶんの`C-c`にならないようにする（unique制約が止める）
  it("同じ種別の未処理の操作があれば積まない", async () => {
    dispatchJobCreate.mockRejectedValue(new Error("Unique constraint failed"));
    const result = await control();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("already_queued");
  });
});

/**
 * #1332。制御ジョブは**起動より先に・同時実行数の枠外で**払い出す。tmuxを1回叩くだけで
 * 重くないうえ、起動待ちの後ろに並ばせると止めたいときほど待たされる。
 */
describe("claimDispatchJobs の制御ジョブ", () => {
  function queuedJob(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1332,
      targetHost: "subpc",
      kind: "LAUNCH",
      status: "QUEUED",
      message: null,
      tmuxSessionName: null,
      createdAt: NOW,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("同時実行数が埋まっていても制御ジョブは払い出す", async () => {
    // 起動ジョブで枠が埋まっている状態
    dispatchJobCount.mockResolvedValue(2);
    dispatchJobFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const kind = args.where?.kind as { in?: string[] } | string | undefined;
      if (typeof kind === "object" && kind?.in) {
        return [queuedJob({ id: "control-1", kind: "KILL" })];
      }
      // 1回目はexpireStaleDispatchJobs、起動ジョブの候補は空
      return [];
    });

    const claimed = await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(claimed.map((job) => job.id)).toEqual(["control-1"]);
  });

  // セッションが上限（#1361）に達したpollerは`maxJobs: 0`で取りに来る。
  // **そういうときこそ停止・終了は届かないと困る**（届かないと5分で失効する）
  it("起動ジョブが要らない（maxJobs: 0）と言われても制御ジョブは渡す", async () => {
    dispatchJobFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const kind = args.where?.kind as { in?: string[] } | string | undefined;
      if (typeof kind === "object" && kind?.in) {
        return [queuedJob({ id: "control-1", kind: "INTERRUPT" })];
      }
      return [];
    });

    const claimed = await claimDispatchJobs({ hostName: "subpc", maxJobs: 0, now: NOW });
    expect(claimed.map((job) => job.id)).toEqual(["control-1"]);
    // 起動ジョブの候補は引きに行かない
    const launchQueries = dispatchJobFindMany.mock.calls
      .map((call) => (call[0]?.where ?? {}) as Record<string, unknown>)
      .filter((where) => where.kind === "LAUNCH");
    expect(launchQueries).toEqual([]);
  });

  it("対応していないホストには制御ジョブを配らない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ sessionControlCapable: null }));
    dispatchJobFindMany.mockResolvedValue([]);

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    // 制御ジョブを取りに行く問い合わせ自体が無いこと（失効を掃く問い合わせは種別を見るので除く）
    const claimQueries = dispatchJobFindMany.mock.calls
      .map((call) => (call[0]?.where ?? {}) as Record<string, unknown>)
      .filter((where) => where.targetHost !== undefined);
    expect(claimQueries.length).toBeGreaterThan(0);
    for (const where of claimQueries) {
      expect(where.kind).toBe("LAUNCH");
    }
  });

  // 枠を消費させると、停止を1回押しただけで次の起動が詰まる
  it("枠の計算に数えるのは起動ジョブだけ", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    expect(dispatchJobCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: "LAUNCH" }) }),
    );
  });
});

/**
 * #1332。**待たせるほど危険になる操作**なので、届かなかった制御ジョブは短い時間で落とす
 * （何時間も後に届いた`C-c`は、そのとき走っている別の作業を止める）。
 */
describe("expireStaleDispatchJobs の制御ジョブ", () => {
  it("取りに来られないままのQUEUEDをTIMEOUTにする", async () => {
    dispatchJobFindMany.mockResolvedValue([
      { id: "control-1", status: "QUEUED", kind: "INTERRUPT" },
    ]);
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
    dispatchSessionFindFirst.mockResolvedValue(null);

    await enqueue();

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "control-1", status: "QUEUED" },
        data: expect.objectContaining({ status: "TIMEOUT", activeKey: null }),
      }),
    );
  });
});
