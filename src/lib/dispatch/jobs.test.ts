import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchHostFindUnique = vi.fn();
const dispatchSessionFindFirst = vi.fn();
const dispatchJobCreate = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchJobFindUnique = vi.fn();
const dispatchJobUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
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
    },
  },
}));

// jobs.ts → sessions.ts → session-escalation.ts の連鎖でGitHub Appの環境変数を読みに行く。
// このテストの対象では使わないため、sessions.test.tsと同じように差し替える
vi.mock("@/lib/dispatch/session-escalation", () => ({
  escalateFailedSession: vi.fn(),
}));

const { enqueueDispatchJob, reportDispatchJob } = await import("./jobs");

const NOW = new Date("2026-08-14T12:00:00.000Z");
const REPOSITORY = "guchi-apps/issue-deck";

function host(overrides: Record<string, unknown> = {}) {
  return {
    name: "subpc",
    repositories: JSON.stringify([REPOSITORY]),
    // 生存判定の窓（5分）の内側
    lastSeenAt: new Date(NOW.getTime() - 30_000),
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
