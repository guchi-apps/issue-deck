import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchHostFindUnique = vi.fn();
const dispatchSessionFindFirst = vi.fn();
const dispatchSessionFindMany = vi.fn();
// 計画への返事待ち（#2061）。`listDispatchState`が同じ応答へ載せるので、行が無くても
// クエリ自体は必ず走る
const sessionPlanRequestFindMany = vi.fn();
const sessionPlanRequestUpdateMany = vi.fn();
const sessionQuestionRequestFindMany = vi.fn();
const sessionQuestionRequestUpdateMany = vi.fn();
const dispatchJobCreate = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchJobFindUnique = vi.fn();
const dispatchJobFindFirst = vi.fn();
const dispatchJobUpdateMany = vi.fn();
const dispatchJobCount = vi.fn();
const dispatchHostFindMany = vi.fn();
const repositoryFindMany = vi.fn();
const repositoryFindFirst = vi.fn();
const issueFindMany = vi.fn();
const issueFindFirst = vi.fn();
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
      get findMany() {
        return dispatchHostFindMany;
      },
    },
    // 実行キューの行に出すIssueタイトルの引き当て（#1519）と、
    // 代行実行の本文・ラベルの引き当て（#1828）
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
      get findFirst() {
        return repositoryFindFirst;
      },
    },
    issue: {
      get findMany() {
        return issueFindMany;
      },
      get findFirst() {
        return issueFindFirst;
      },
    },
    dispatchSession: {
      get findFirst() {
        return dispatchSessionFindFirst;
      },
      get findMany() {
        return dispatchSessionFindMany;
      },
    },
    sessionPlanRequest: {
      get findMany() {
        return sessionPlanRequestFindMany;
      },
      get updateMany() {
        return sessionPlanRequestUpdateMany;
      },
    },
    sessionQuestionRequest: {
      get findMany() {
        return sessionQuestionRequestFindMany;
      },
      get updateMany() {
        return sessionQuestionRequestUpdateMany;
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
      get findFirst() {
        return dispatchJobFindFirst;
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

const {
  claimDispatchJobs,
  dismissDispatchJob,
  enqueueCrossRepoQuestionJob,
  enqueueDispatchJob,
  enqueueManualStepAbortJob,
  enqueueManualStepJob,
  enqueueCodeReviewJob,
  enqueuePlanReviewJob,
  enqueueSessionControlJob,
  expireStaleDispatchJobs,
  listDispatchState,
  prioritizeDispatchJob,
  reportDispatchJob,
} = await import("./jobs");

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
    instructionCapable: true,
    // 横断質問（#1454）に対応したpoller
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    // 計画レビュー（#1855）に対応したpoller
    planReviewCapable: true,
    codeReviewCapable: true,
    selfUpdateCapable: null,
    previewCapable: null,
    // DBの行の形（`toHostView`が読む列名）。**Viewの`reboot`とは名前が違う**
    rebootCapable: null,
    rebootRequired: null,
    rebootRequiredSince: null,
    bootedAt: null,
    previewRepositories: null,
    preview: null,
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
  sessionPlanRequestFindMany.mockResolvedValue([]);
  sessionPlanRequestUpdateMany.mockResolvedValue({ count: 0 });
  sessionQuestionRequestFindMany.mockResolvedValue([]);
  sessionQuestionRequestUpdateMany.mockResolvedValue({ count: 0 });
  dispatchJobFindFirst.mockResolvedValue(null);
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
  async function control(
    kind: "INTERRUPT" | "KILL" | "INSTRUCTION" = "INTERRUPT",
    instruction?: string,
  ) {
    return enqueueSessionControlJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 1332,
      hostName: "subpc",
      kind,
      instruction,
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

  // #1012。本文は`INSTRUCTION`のときだけ保存し、それ以外の種別では持たせない
  it("追加指示は本文を持ち、専用の名前空間で積む", async () => {
    const result = await control("INSTRUCTION", "計画を承認します。実装に進んでください。");
    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "INSTRUCTION",
          activeKey: "instruction:guchi-apps/issue-deck#1332",
          instruction: "計画を承認します。実装に進んでください。",
        }),
      }),
    );
  });

  it("停止・終了には本文を持たせない", async () => {
    await control("KILL", "紛れ込んだ本文");
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ instruction: null }) }),
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
/**
 * #1454。**起動ジョブとは判定が違う。** 記録先リポジトリがサブPCにcloneされている必要は無く
 * （worktreeを作らず、記録先へは`gh issue comment`で書くだけ）、代わりに参照できるリポジトリが
 * 1件以上あることとpollerの対応を見る。
 */
describe("enqueueCrossRepoQuestionJob", () => {
  const QUESTION_REPOSITORY = "guchi-apps/question";

  async function enqueueQuestion() {
    return enqueueCrossRepoQuestionJob({
      repositoryFullName: QUESTION_REPOSITORY,
      issueNumber: 12,
      hostName: "subpc",
      requestedByUserId: null,
      now: NOW,
    });
  }

  it("記録先がサブPCにcloneされていなくても積める", async () => {
    // 申告に載っているのはissue-deckだけ＝`question`リポジトリはcloneされていない
    const result = await enqueueQuestion();
    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "CROSS_REPO_QUESTION",
          repositoryFullName: QUESTION_REPOSITORY,
          // 実装ジョブとは名前空間を分ける（実装中のIssueへも質問を積めるように）
          activeKey: "cross_repo_question:guchi-apps/question#12",
        }),
      }),
    );
  });

  it("横断質問に対応していないpollerへは積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ crossRepoQuestionCapable: null }));
    const result = await enqueueQuestion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("cross_repo_question_unsupported");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("参照できるリポジトリが1つも無ければ積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ repositories: "[]" }));
    const result = await enqueueQuestion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("no_runnable_repositories");
  });

  it("同じ質問Issueのセッションが動いていれば積まない", async () => {
    dispatchSessionFindFirst.mockResolvedValue(
      aliveSession({ repositoryFullName: QUESTION_REPOSITORY, issueNumber: 12 }),
    );
    const result = await enqueueQuestion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("session_alive");
  });

  it("申告が届いていないホストには積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(null);
    const result = await enqueueQuestion();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("host_unknown");
  });
});

/**
 * 計画の関門（G1・#1855）。**計画コメントの投稿を契機に自動で積まれる**ため、
 * 「実装セッションが動いていても積める」ことがこの種別の要点。
 */
describe("enqueuePlanReviewJob", () => {
  async function enqueuePlanReview() {
    return enqueuePlanReviewJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 1855,
      hostName: "subpc",
      requestedByUserId: null,
      now: NOW,
    });
  }

  it("実装セッションが動いていても積める（計画の承認待ちがまさにその状態）", async () => {
    dispatchSessionFindFirst.mockResolvedValue(
      aliveSession({ repositoryFullName: REPOSITORY, issueNumber: 1855 }),
    );

    const result = await enqueuePlanReview();

    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "PLAN_REVIEW",
          // 実装ジョブとは名前空間を分ける（同じIssueへ重ねて積めるように）
          activeKey: "plan_review:guchi-apps/issue-deck#1855",
        }),
      }),
    );
  });

  it("計画レビューに対応していないpollerへは積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ planReviewCapable: null }));

    const result = await enqueuePlanReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("plan_review_unsupported");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  // 横断質問と違い、対象リポジトリのコードを読むのでcloneが要る
  it("そのホストで実行できないリポジトリには積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ repositories: "[]" }));

    const result = await enqueuePlanReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("repository_not_runnable");
  });

  it("申告が届いていないホストには積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(null);

    const result = await enqueuePlanReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("host_unknown");
  });

  // activeKeyのunique制約が二重投入を止める（計画を出し直したときの重複起動もここで止まる）
  it("未処理の計画レビューがあれば積まない", async () => {
    dispatchJobCreate.mockRejectedValue(new Error("unique"));

    const result = await enqueuePlanReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("already_queued");
  });
});

/**
 * リポジトリ全体のコードレビュー（#698）。**人が画面から押したときだけ積まれる。**
 * レビューのたびに新しいIssueを立てるので、`already_queued`で止まるのは同じレビューIssueへの
 * 押し直しだけ。
 */
describe("enqueueCodeReviewJob", () => {
  async function enqueueCodeReview() {
    return enqueueCodeReviewJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 698,
      hostName: "subpc",
      requestedByUserId: null,
      now: NOW,
    });
  }

  it("専用の名前空間のactiveKeyで積む", async () => {
    const result = await enqueueCodeReview();

    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "CODE_REVIEW",
          activeKey: "code_review:guchi-apps/issue-deck#698",
        }),
      }),
    );
  });

  it("コードレビューに対応していないpollerへは積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ codeReviewCapable: null }));

    const result = await enqueueCodeReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("code_review_unsupported");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  // レビューは対象リポジトリのコードそのものが主題なので、cloneが無ければ読むものが無い
  it("チェックアウトが無いリポジトリには積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ repositories: "[]" }));

    const result = await enqueueCodeReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("repository_not_runnable");
  });

  it("同じレビューIssueへ重ねて積まない", async () => {
    dispatchJobCreate.mockRejectedValue(new Error("unique"));

    const result = await enqueueCodeReview();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("already_queued");
  });
});

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

  // 中断（#1882）は代行実行とは別の申告で配る。**未対応のpollerへ配ると`failed`になるだけ**で、
  // そのときは打ち切りを待つ案内を出す方が正しい
  it("中断に対応していないpollerには中断ジョブを配らない", async () => {
    dispatchHostFindUnique.mockResolvedValue(
      host({ manualStepCapable: true, manualStepAbortCapable: null }),
    );
    dispatchJobCount.mockResolvedValue(0);
    const requestedKinds: string[][] = [];
    dispatchJobFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const kind = args.where?.kind as { in?: string[] } | undefined;
      if (kind?.in) requestedKinds.push(kind.in);
      return [];
    });

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const controlKinds = requestedKinds.find((kinds) => kinds.includes("MANUAL_STEP")) ?? [];
    expect(controlKinds).not.toContain("MANUAL_STEP_ABORT");
  });

  it("中断に対応したpollerには中断ジョブも配る", async () => {
    dispatchHostFindUnique.mockResolvedValue(
      host({ manualStepCapable: true, manualStepAbortCapable: true }),
    );
    dispatchJobCount.mockResolvedValue(0);
    const requestedKinds: string[][] = [];
    dispatchJobFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const kind = args.where?.kind as { in?: string[] } | undefined;
      if (kind?.in) requestedKinds.push(kind.in);
      return [];
    });

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const controlKinds = requestedKinds.find((kinds) => kinds.includes("MANUAL_STEP")) ?? [];
    expect(controlKinds).toContain("MANUAL_STEP_ABORT");
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

  // 軽い巡回（#2413）は`maxJobs: 0`で枠外のジョブだけを取りに来る。**代行実行がそこに
  // 含まれていることが、この巡回が速さを稼げる根拠そのもの**（手作業アシスタントは1手順ごとに
  // ジョブを積み直すため、ここが渡らないと待ちが手順の数だけ積み上がる）
  it("起動ジョブが要らない（maxJobs: 0）と言われても代行実行は渡す", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepCapable: true }));
    dispatchJobFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const kind = args.where?.kind as { in?: string[] } | string | undefined;
      if (typeof kind === "object" && kind?.in?.includes("MANUAL_STEP")) {
        return [queuedJob({ id: "manual-1", kind: "MANUAL_STEP" })];
      }
      return [];
    });

    const claimed = await claimDispatchJobs({ hostName: "subpc", maxJobs: 0, now: NOW });
    expect(claimed.map((job) => job.id)).toEqual(["manual-1"]);
  });

  /** claimが引きに行った種別の一覧（失効を掃く問い合わせは`targetHost`が無いので除く） */
  function claimedKinds(): unknown[] {
    return dispatchJobFindMany.mock.calls
      .map((call) => (call[0]?.where ?? {}) as Record<string, unknown>)
      .filter((where) => where.targetHost !== undefined)
      .map((where) => where.kind);
  }

  it("何も申告していないホストには制御ジョブを配らない", async () => {
    dispatchHostFindUnique.mockResolvedValue(
      host({ sessionControlCapable: null, instructionCapable: null }),
    );
    dispatchJobFindMany.mockResolvedValue([]);

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const kinds = claimedKinds();
    expect(kinds.length).toBeGreaterThan(0);
    // 引きに行くのはセッションを立てる種別（#1454で横断質問が加わった）だけで、制御ジョブは無い
    for (const kind of kinds) {
      const list =
        typeof kind === "object" && kind !== null && "in" in kind
          ? (kind as { in: string[] }).in
          : [kind];
      expect(list).not.toContain("INTERRUPT");
      expect(list).not.toContain("KILL");
      expect(list).not.toContain("INSTRUCTION");
    }
  });

  // #1012。停止・終了は固定の`C-c`だけを送るのに対し、追加指示は内容のある文字列を送る。
  // 実装が入っていないpollerへ配ると未知の種別として`failed`になり、指示が必ず失われる
  it("申告は種別ごとに独立している", async () => {
    dispatchJobFindMany.mockResolvedValue([]);

    dispatchHostFindUnique.mockResolvedValue(host({ instructionCapable: null }));
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(claimedKinds()).toContainEqual({ in: ["INTERRUPT", "KILL"] });

    dispatchJobFindMany.mockClear();
    dispatchHostFindUnique.mockResolvedValue(host({ sessionControlCapable: null }));
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(claimedKinds()).toContainEqual({ in: ["INSTRUCTION"] });

    dispatchJobFindMany.mockClear();
    dispatchHostFindUnique.mockResolvedValue(host());
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(claimedKinds()).toContainEqual({ in: ["INTERRUPT", "KILL", "INSTRUCTION"] });
  });

  // #2496。**落とす前に入口を閉じないと、押してから届くまでの数十秒に新しいセッションが立ち、
  // pollerの「0本か」の確かめ直しに引っかかって再起動そのものが失敗する**
  it("再起動が積まれている間は起動ジョブを配らない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ rebootCapable: true }));
    dispatchJobCount.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
      args.where?.kind === "REBOOT" ? 1 : 0,
    );
    dispatchJobFindMany.mockResolvedValue([]);

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    // 制御ジョブ（再起動を含む枠外の種別）は引きに行くが、起動ジョブの候補は引かない
    const kinds = claimedKinds();
    expect(kinds).toContainEqual(expect.objectContaining({ in: expect.arrayContaining(["REBOOT"]) }));
    expect(kinds).not.toContainEqual({
      in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"],
    });
  });

  it("再起動が積まれていなければ従来どおり起動ジョブを配る", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ rebootCapable: true }));
    dispatchJobCount.mockResolvedValue(0);
    dispatchJobFindMany.mockResolvedValue([]);

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    expect(claimedKinds()).toContainEqual({
      in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"],
    });
  });

  // **申告していないpollerへ配ると未知の種別として`failed`になり、押した再起動が失われる**
  it("再起動に対応していないpollerには再起動ジョブを配らない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ rebootCapable: null }));
    dispatchJobCount.mockResolvedValue(0);
    dispatchJobFindMany.mockResolvedValue([]);

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    for (const kind of claimedKinds()) {
      const list =
        typeof kind === "object" && kind !== null && "in" in kind
          ? (kind as { in: string[] }).in
          : [kind];
      expect(list).not.toContain("REBOOT");
    }
  });

  // 枠を消費させると、停止を1回押しただけで次の起動が詰まる
  // 数えるのはセッションを立てるジョブ（起動・横断質問。#1454）だけで、制御ジョブは枠を消費しない
  it("枠の計算に数えるのはセッションを立てるジョブだけ", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    expect(dispatchJobCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"] },
        }),
      }),
    );
  });

  // #1454。**申告したホストにだけ配る。** 古いpollerは未知の種別として失敗で返すため、
  // 配ると質問が必ず失われる
  it("横断質問は申告したホストにだけ払い出す", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(dispatchJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "QUEUED",
          kind: { in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"] },
        }),
      }),
    );

    vi.clearAllMocks();
    dispatchJobFindMany.mockResolvedValue([]);
    dispatchJobCount.mockResolvedValue(0);
    appSettingFindUnique.mockResolvedValue({ id: 1, dispatchConcurrency: 2 });
    // 横断質問も計画レビューもコードレビューも申告していない古いpoller
    // （#1855・#698で同じ向きの申告が増えた）
    dispatchHostFindUnique.mockResolvedValue(
      host({ crossRepoQuestionCapable: null, planReviewCapable: null, codeReviewCapable: null }),
    );
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });
    expect(dispatchJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "QUEUED", kind: { in: ["LAUNCH"] } }),
      }),
    );
  });

  // #1541。**画面（summarizeDispatchQueue）と同じ並びで引く。** ずれると、画面に見えている
  // 順番と実際に走る順番が食い違う。制御ジョブは枠外で先に配られるので、順番の概念が無い
  it("起動ジョブは先頭へ上げた順→積んだ順で引き、制御ジョブは積んだ順のまま", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const orderByFor = (kinds: string[]) =>
      dispatchJobFindMany.mock.calls
        .map((call) => call[0] as { where?: Record<string, unknown>; orderBy?: unknown })
        .find(
          (args) =>
            JSON.stringify((args.where?.kind as { in?: string[] })?.in ?? []) ===
            JSON.stringify(kinds),
        )?.orderBy;

    expect(orderByFor(["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"])).toEqual([
      { queuePriority: "desc" },
      { createdAt: "asc" },
    ]);
    expect(orderByFor(["INTERRUPT", "KILL", "INSTRUCTION"])).toEqual({ createdAt: "asc" });
  });

  // #1294。現行のpollerは未知の種別を「未知のジョブ種別です」として失敗で返すため、
  // 実行側が来ていない段階で配ると質問が必ず失敗として残る（払い出しはStep 3で開ける）
  it("質問ジョブは払い出さない", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const claimQueries = dispatchJobFindMany.mock.calls
      .map((call) => (call[0]?.where ?? {}) as Record<string, unknown>)
      .filter((where) => where.targetHost !== undefined);
    for (const where of claimQueries) {
      const kind = where.kind as { in?: string[] } | string | undefined;
      const kinds = typeof kind === "object" && kind?.in ? kind.in : [kind];
      expect(kinds).not.toContain("QUESTION");
    }
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

/**
 * #1620。pollerは`succeeded`の報告に失敗しても再送を諦めるため、tmuxセッションは立っているのに
 * ジョブが`RUNNING`のまま残ることがある。そのままタイムアウトさせると、同じIssueが実行キューの
 * 「実行中」（セッション一覧）と「直近の失敗」に同時に出る。
 */
describe("expireStaleDispatchJobs の起動ジョブ救済", () => {
  function staleLaunchJob(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      status: "RUNNING",
      kind: "LAUNCH",
      targetHost: "subpc",
      repositoryFullName: REPOSITORY,
      issueNumber: 1311,
      tmuxSessionName: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
    dispatchSessionFindMany.mockResolvedValue([]);
  });

  it("セッションが動いていればSUCCEEDEDとして畳み、セッション名を補う", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob()]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "RUNNING" },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        activeKey: null,
        finishedAt: NOW,
        tmuxSessionName: "issue-deck-issue-1311",
      }),
    });
  });

  // claim直後に報告が届かなかった場合も同じ（`running`と`succeeded`の両方を落とすと起きる）
  it("CLAIMEDのままでもセッションが動いていれば救済する", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob({ status: "CLAIMED" })]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
    );
  });

  it("セッションが無ければ従来どおりTIMEOUTにする", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob()]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TIMEOUT" }) }),
    );
  });

  /**
   * #1855。計画レビューのセッションは`-issue-`の規約から外れているためpollerが報告せず、
   * `DispatchSession`の行にならない。ここで救済の対象にすると、代わりに**同じIssueの
   * 実装セッション**（計画の承認待ちで生きている）に一致し、届かなかったレビューを
   * 「起動できていた」ことにしてしまう。
   */
  it("計画レビューは、同じIssueの実装セッションで救済しない", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob({ kind: "PLAN_REVIEW" })]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TIMEOUT" }) }),
    );
  });

  /**
   * #2443。コードレビュー（#698）のセッション名も`<repo>-code-review-<番号>`と`-issue-`の規約から
   * 外してあるため、計画レビューとまったく同じ理由で救済の対象にできない。
   */
  it("コードレビューは、同じIssueの実装セッションで救済しない", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob({ kind: "CODE_REVIEW" })]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TIMEOUT" }) }),
    );
  });

  // 横断質問（#1454）は`expected_session_name`で立つため、実装セッションと同じ規約で報告される
  it("横断質問は、報告されたセッションで救済する", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob({ kind: "CROSS_REPO_QUESTION" })]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
    );
  });

  // pollerごと落ちていれば`ALIVE`の行はそのまま古びて残る。古い報告で成功と決めない
  it("探すのは報告が新しいALIVEのセッションだけ", async () => {
    dispatchJobFindMany.mockResolvedValue([staleLaunchJob()]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "ALIVE",
          lastReportedAt: { gte: new Date(NOW.getTime() - 5 * 60 * 1000) },
          OR: [{ host: "subpc", repositoryFullName: REPOSITORY, issueNumber: 1311 }],
        }),
      }),
    );
  });

  // 制御ジョブはtmuxを1回叩いて終わる。セッションが動いていることは届いた証拠にならない
  it("制御ジョブは救済しない", async () => {
    dispatchJobFindMany.mockResolvedValue([
      staleLaunchJob({ id: "control-1", status: "QUEUED", kind: "INTERRUPT" }),
    ]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        repositoryFullName: REPOSITORY,
        issueNumber: 1311,
        tmuxSessionName: "issue-deck-issue-1311",
      },
    ]);

    await expireStaleDispatchJobs(NOW);

    expect(dispatchSessionFindMany).not.toHaveBeenCalled();
    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "TIMEOUT" }) }),
    );
  });
});

/**
 * #1479。終了したジョブは24時間表示され続けるため、対処が済んだ失敗を畳めないと新しい失敗が
 * 古いものに埋もれる。**行は消さず`dismissedAt`を入れるだけ**で、失敗理由は後から追える。
 */
describe("dismissDispatchJob", () => {
  function failedJob(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1311,
      targetHost: "subpc",
      kind: "LAUNCH",
      status: "FAILED",
      message: "tmuxの起動に失敗しました。",
      instruction: null,
      command: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      tmuxSessionName: null,
      createdAt: NOW,
      claimedAt: null,
      startedAt: null,
      finishedAt: NOW,
      dismissedAt: null,
      ...overrides,
    };
  }

  it("終了したジョブにはdismissedAtを入れる", async () => {
    dispatchJobFindUnique
      .mockResolvedValueOnce(failedJob())
      .mockResolvedValueOnce(failedJob({ dismissedAt: NOW }));
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });

    const result = await dismissDispatchJob({ jobId: "job-1", now: NOW });

    expect(result.ok).toBe(true);
    expect(dispatchJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-1", dismissedAt: null },
      data: { dismissedAt: NOW },
    });
  });

  it("既に消してあれば書き込まずに成功を返す（連打で失敗させない）", async () => {
    dispatchJobFindUnique.mockResolvedValue(failedJob({ dismissedAt: NOW }));

    const result = await dismissDispatchJob({ jobId: "job-1", now: NOW });

    expect(result.ok).toBe(true);
    expect(dispatchJobUpdateMany).not.toHaveBeenCalled();
  });

  // 走っているものを表示だけ消せると、動いている実体が画面のどこにも出ないまま残る
  it.each(["QUEUED", "CLAIMED", "RUNNING"])("未完了（%s）は消せない", async (status) => {
    dispatchJobFindUnique.mockResolvedValue(failedJob({ status, finishedAt: null }));

    const result = await dismissDispatchJob({ jobId: "job-1", now: NOW });

    expect(result).toMatchObject({ ok: false, reason: "not_dismissable" });
    expect(dispatchJobUpdateMany).not.toHaveBeenCalled();
  });

  it("存在しないIDはnot_found", async () => {
    dispatchJobFindUnique.mockResolvedValue(null);

    const result = await dismissDispatchJob({ jobId: "missing", now: NOW });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

/**
 * 先頭へ上げる（#1541）。夜にまとめて積んだあと「これを次に流したい」が出てくるが、
 * キューは`createdAt`の昇順で固定されていて、取り消して積み直すと最後尾へ回るだけだった。
 */
describe("prioritizeDispatchJob", () => {
  function queuedJob(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1311,
      targetHost: "subpc",
      kind: "LAUNCH",
      status: "QUEUED",
      message: null,
      instruction: null,
      command: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      tmuxSessionName: null,
      queuePriority: 0,
      createdAt: NOW,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      dismissedAt: null,
      ...overrides,
    };
  }

  it("同じホストの順番待ちの最大値+1を入れる", async () => {
    dispatchJobFindUnique
      .mockResolvedValueOnce(queuedJob())
      .mockResolvedValueOnce(queuedJob({ queuePriority: 4 }));
    dispatchJobFindFirst.mockResolvedValue({ queuePriority: 3 });
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });

    const result = await prioritizeDispatchJob({ jobId: "job-1" });

    expect(result.ok).toBe(true);
    expect(dispatchJobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "QUEUED" },
      data: { queuePriority: 4 },
    });
    // 他ホストの値に引きずられないよう、絞り込みはtargetHostを含む
    expect(dispatchJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetHost: "subpc", status: "QUEUED" }),
      }),
    );
  });

  it("先頭へ上げるのが初めてなら1になる", async () => {
    dispatchJobFindUnique
      .mockResolvedValueOnce(queuedJob())
      .mockResolvedValueOnce(queuedJob({ queuePriority: 1 }));
    dispatchJobFindFirst.mockResolvedValue({ queuePriority: 0 });
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });

    await prioritizeDispatchJob({ jobId: "job-1" });

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { queuePriority: 1 } }),
    );
  });

  // 走り始めたジョブの並びを書き換えても意味が無い
  it.each(["CLAIMED", "RUNNING", "SUCCEEDED", "FAILED"])(
    "順番待ち以外（%s）は上げられない",
    async (status) => {
      dispatchJobFindUnique.mockResolvedValue(queuedJob({ status }));

      const result = await prioritizeDispatchJob({ jobId: "job-1" });

      expect(result).toMatchObject({ ok: false, reason: "not_prioritizable" });
      expect(dispatchJobUpdateMany).not.toHaveBeenCalled();
    },
  );

  // 制御ジョブは同時実行数の枠外で起動ジョブより先に配られるので、順番の概念が無い
  it.each(["INTERRUPT", "KILL", "INSTRUCTION"])("制御ジョブ（%s）は上げられない", async (kind) => {
    dispatchJobFindUnique.mockResolvedValue(queuedJob({ kind }));

    const result = await prioritizeDispatchJob({ jobId: "job-1" });

    expect(result).toMatchObject({ ok: false, reason: "not_prioritizable" });
    expect(dispatchJobUpdateMany).not.toHaveBeenCalled();
  });

  // 横断質問セッションは起動ジョブと同じ枠で走るので、順番がある
  it("横断質問ジョブは上げられる", async () => {
    dispatchJobFindUnique
      .mockResolvedValueOnce(queuedJob({ kind: "CROSS_REPO_QUESTION" }))
      .mockResolvedValueOnce(queuedJob({ kind: "CROSS_REPO_QUESTION", queuePriority: 1 }));
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });

    const result = await prioritizeDispatchJob({ jobId: "job-1" });

    expect(result.ok).toBe(true);
  });

  // 押した瞬間にpollerが持っていった場合。updateManyが0件で落ちる
  it("押した直後に払い出されたら断る", async () => {
    dispatchJobFindUnique.mockResolvedValue(queuedJob());
    dispatchJobUpdateMany.mockResolvedValue({ count: 0 });

    const result = await prioritizeDispatchJob({ jobId: "job-1" });

    expect(result).toMatchObject({ ok: false, reason: "not_prioritizable" });
  });

  it("存在しないIDはnot_found", async () => {
    dispatchJobFindUnique.mockResolvedValue(null);

    const result = await prioritizeDispatchJob({ jobId: "missing" });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

/**
 * #1519。実行キューの行に番号しか出ないと、何のジョブが積まれているのかがGitHubを開くまで
 * 分からない。タイトルはDBのIssueキャッシュから**まとめて**引く。
 */
describe("listDispatchState のIssueタイトル解決", () => {
  function jobRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1519,
      targetHost: "subpc",
      kind: "LAUNCH",
      status: "QUEUED",
      message: null,
      instruction: null,
      command: null,
      manualStepLine: null,
      targetJobId: null,
      previewAction: null,
      exitCode: null,
      commandOutput: null,
      tmuxSessionName: null,
      queuePriority: 0,
      createdAt: NOW,
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    dispatchHostFindMany.mockResolvedValue([]);
    dispatchSessionFindMany.mockResolvedValue([]);
    repositoryFindMany.mockResolvedValue([]);
    issueFindMany.mockResolvedValue([]);
  });

  it("キャッシュにあるタイトルを行へ載せる", async () => {
    // 1回目はexpireStaleDispatchJobs、2回目が一覧
    dispatchJobFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([jobRow()]);
    repositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: REPOSITORY }]);
    issueFindMany.mockResolvedValue([
      {
        githubIssueId: BigInt(3021519),
        number: 1519,
        title: "実行キューの状態を可視化する",
        repositoryId: "repo-1",
      },
    ]);

    const state = await listDispatchState(NOW);

    expect(state.jobs[0].issueTitle).toBe("実行キューの状態を可視化する");
    // 画面はこのidでIssue詳細を開く（#1625）。番号だけでは飛べない。
    // **DBの行id（cuid）ではなく`String(githubIssueId)`**（#1671）。画面の`Issue.id`は
    // `dbIssueToDisplayIssue`が同じ形で作っており、行idを返すと一覧のどれにも一致しない
    expect(state.jobs[0].issueId).toBe("3021519");
  });

  // セッションの行のタイトルもIssueへの導線になる（#1625）。ジョブと同じ1回の引き当てで賄う
  it("セッションの行にもタイトルとidを載せる", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    dispatchSessionFindMany.mockResolvedValue([
      {
        host: "subpc",
        tmuxSessionName: "issue-deck-issue-1519",
        repositoryFullName: REPOSITORY,
        issueNumber: 1519,
        state: "ALIVE",
        exitStatus: null,
        firstSeenAt: NOW,
        lastReportedAt: NOW,
        activity: null,
        activityAt: null,
        remoteControlUrl: null,
        previewUrl: null,
      },
    ]);
    repositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: REPOSITORY }]);
    issueFindMany.mockResolvedValue([
      {
        githubIssueId: BigInt(3021519),
        number: 1519,
        title: "実行キューの状態を可視化する",
        repositoryId: "repo-1",
      },
    ]);

    const state = await listDispatchState(NOW);

    expect(state.sessions[0].issueTitle).toBe("実行キューの状態を可視化する");
    // ジョブの行と同じく`String(githubIssueId)`（#1671）
    expect(state.sessions[0].issueId).toBe("3021519");
  });

  // 同期前のIssue・GitHub Appを外したリポジトリでは普通に起きる。ここで落とすとキュー全体が消える
  it("引けなければnullのまま返す", async () => {
    dispatchJobFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([jobRow()]);
    repositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: REPOSITORY }]);
    issueFindMany.mockResolvedValue([]);

    const state = await listDispatchState(NOW);

    expect(state.jobs[0].issueTitle).toBeNull();
    // idも無いので、画面はこの行をリンクにしない（押しても何も起きない行を作らない）
    expect(state.jobs[0].issueId).toBeNull();
  });

  // 別リポジトリの同じ番号を取り違えると、まったく違うタイトルが行に出る
  it("リポジトリが違う同じ番号を取り違えない", async () => {
    dispatchJobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        jobRow(),
        jobRow({ id: "job-2", repositoryFullName: "guchi-apps/dayspan" }),
      ]);
    repositoryFindMany.mockResolvedValue([
      { id: "repo-1", fullName: REPOSITORY },
      { id: "repo-2", fullName: "guchi-apps/dayspan" },
    ]);
    issueFindMany.mockResolvedValue([
      { githubIssueId: BigInt(3021519), number: 1519, title: "issue-deck側", repositoryId: "repo-1" },
      { githubIssueId: BigInt(4051519), number: 1519, title: "dayspan側", repositoryId: "repo-2" },
    ]);

    const state = await listDispatchState(NOW);

    expect(state.jobs.find((job) => job.id === "job-1")?.issueTitle).toBe("issue-deck側");
    expect(state.jobs.find((job) => job.id === "job-2")?.issueTitle).toBe("dayspan側");
    // idも取り違えない（リンク先が別リポジトリのIssueになる。#1671）
    expect(state.jobs.find((job) => job.id === "job-1")?.issueId).toBe("3021519");
    expect(state.jobs.find((job) => job.id === "job-2")?.issueId).toBe("4051519");
  });

  // ここはポーリング先（未完了ジョブがある間は5秒間隔）。ジョブ1件ごとに引かない
  it("ジョブが何件あってもクエリは2本まで、0件なら投げない", async () => {
    dispatchJobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        jobRow(),
        jobRow({ id: "job-2", issueNumber: 1541 }),
        jobRow({ id: "job-3", issueNumber: 1544 }),
      ]);
    repositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: REPOSITORY }]);

    await listDispatchState(NOW);
    expect(repositoryFindMany).toHaveBeenCalledTimes(1);
    expect(issueFindMany).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    dispatchJobFindMany.mockResolvedValue([]);
    dispatchHostFindMany.mockResolvedValue([]);
    dispatchSessionFindMany.mockResolvedValue([]);
    appSettingFindUnique.mockResolvedValue({ id: 1, dispatchConcurrency: 2 });

    await listDispatchState(NOW);
    expect(repositoryFindMany).not.toHaveBeenCalled();
    expect(issueFindMany).not.toHaveBeenCalled();
  });
});

/**
 * 手作業の代行実行（#1828）。
 *
 * **ここが「画面から任意のコマンドを流せる口」にならないための一次の歯止め。** 画面から届いた
 * 文字列は照合にしか使わず、ジョブに載せるのは本文から抽出し直したものであることを確かめる。
 */
describe("enqueueManualStepJob", () => {
  const MANUAL_STEP_BODY = `## 前提条件

- 実行するデバイス: **サブPC**
- カレントディレクトリ: \`~/apps/issue-deck\`

## やること

- [ ] チェックアウトを更新する

    \`\`\`bash
    cd ~/apps/issue-deck
    git pull --ff-only
    \`\`\`
`;
  // `- [ ] チェックアウトを更新する` の行番号（1始まり）
  const STEP_LINE = MANUAL_STEP_BODY.split("\n").indexOf("- [ ] チェックアウトを更新する") + 1;
  const COMMAND = "cd ~/apps/issue-deck\ngit pull --ff-only";

  function setUpIssue(overrides: { body?: string | null; labels?: { name: string }[] } = {}) {
    repositoryFindFirst.mockResolvedValue({ id: "repo-1" });
    issueFindFirst.mockResolvedValue({
      body: overrides.body === undefined ? MANUAL_STEP_BODY : overrides.body,
      labels: overrides.labels ?? [{ name: "71.manual-step" }],
    });
  }

  async function run(
    overrides: {
      stepLine?: number;
      approvedCommand?: string;
      placeholderValues?: Record<string, string> | null;
    } = {},
  ) {
    return enqueueManualStepJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 1823,
      hostName: "subpc",
      stepLine: overrides.stepLine ?? STEP_LINE,
      approvedCommand: overrides.approvedCommand ?? COMMAND,
      placeholderValues: overrides.placeholderValues ?? null,
      requestedByUserId: "user-1",
      now: NOW,
    });
  }

  /** `<控えたkey>`を埋める手順に差し替える（#2403） */
  function setUpPlaceholderIssue(command = "KEY=<控えたkey> node oauth.mjs") {
    setUpIssue({
      body: MANUAL_STEP_BODY.replace("cd ~/apps/issue-deck\n    git pull --ff-only", command),
    });
    return command;
  }

  beforeEach(() => {
    setUpIssue();
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepCapable: true }));
  });

  // 積んでも代行実行のシェルには標準入力が無く、失敗か打ち切りで終わる（#2025）
  it("対話が要るコマンドは積まない", async () => {
    const body = MANUAL_STEP_BODY.replace("git pull --ff-only", "op signin");
    setUpIssue({ body });
    const result = await run({ approvedCommand: "cd ~/apps/issue-deck\nop signin" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.rejection).toBe("interactive_command");
    // 何を自分で実行すればよいのかまで返す
    expect(result.ok === false && result.message).toContain("op signin");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("本文から抽出し直したコマンドをジョブに載せる", async () => {
    const result = await run();

    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "MANUAL_STEP",
          command: COMMAND,
          manualStepLine: STEP_LINE,
          // Issue単位で1件まで（順番に実行する前提の手順が入れ替わらないようにする）
          activeKey: `manual_step:${REPOSITORY}#1823`,
          requestedByUserId: "user-1",
        }),
      }),
    );
  });

  // 値を埋めて代行実行する（#2403）。**送るのは値だけで、コマンドの形は本文から取る**
  describe("埋めた値を差し込む（#2403）", () => {
    beforeEach(() => {
      dispatchHostFindUnique.mockResolvedValue(
        host({ manualStepCapable: true, manualStepValuesCapable: true }),
      );
    });

    it("値が届かなければ、これまでどおり穴で止まる", async () => {
      const command = setUpPlaceholderIssue();
      const result = await run({ approvedCommand: command });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.rejection).toBe("placeholder_command");
      expect(dispatchJobCreate).not.toHaveBeenCalled();
    });

    // **保存するのはテンプレート。** 本文との照合はサーバーとpollerがこれで2回行い、
    // 値を差し込むのは照合を通したあと
    it("テンプレートと値を分けてジョブに載せる", async () => {
      const command = setUpPlaceholderIssue();
      const result = await run({
        approvedCommand: command,
        placeholderValues: { "<控えたkey>": "kM3q" },
      });

      expect(result.ok).toBe(true);
      expect(dispatchJobCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            command: "KEY=<控えたkey> node oauth.mjs",
            placeholderValues: { "<控えたkey>": "kM3q" },
          }),
        }),
      );
    });

    // **山括弧を全部埋めたかどうかで判定しない**（計画レビューG1・指摘1）。
    // `***`・`…`・`xxx`は名前が付かず埋めようがないので、残っていれば止める
    it("名前の付かないプレースホルダが残っていれば、山括弧を埋めても積まない", async () => {
      const command = setUpPlaceholderIssue("KEY=<控えたkey> SECRET=*** node oauth.mjs");
      const result = await run({
        approvedCommand: command,
        placeholderValues: { "<控えたkey>": "kM3q" },
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.rejection).toBe("placeholder_command");
      expect(dispatchJobCreate).not.toHaveBeenCalled();
    });

    // 古いpollerは知らないフィールドを黙って無視し、穴が空いたままの`command`を実行してしまう
    it("値の差し込みに未対応のpollerへは配らない", async () => {
      dispatchHostFindUnique.mockResolvedValue(
        host({ manualStepCapable: true, manualStepValuesCapable: null }),
      );
      const command = setUpPlaceholderIssue();
      const result = await run({
        approvedCommand: command,
        placeholderValues: { "<控えたkey>": "kM3q" },
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.rejection).toBe("manual_step_values_unsupported");
      expect(dispatchJobCreate).not.toHaveBeenCalled();
    });

    // 画面は開いているIssueぶんの値をまとめて持っている。この手順に合う穴が無ければ
    // **値付きの実行として扱わない**（未対応のpollerでも従来どおり押せる）
    it("差し込む穴が無ければ、値は載せず申告も求めない", async () => {
      dispatchHostFindUnique.mockResolvedValue(
        host({ manualStepCapable: true, manualStepValuesCapable: null }),
      );
      const result = await run({ placeholderValues: { "<控えたkey>": "kM3q" } });

      expect(result.ok).toBe(true);
      expect(dispatchJobCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ command: COMMAND, placeholderValues: undefined }),
        }),
      );
    });

    // 差し込んでよい形を決めるのは`normalizeManualStepPlaceholderValues`の1か所
    it("プレースホルダの表記でないキーは無視する", async () => {
      const command = setUpPlaceholderIssue();
      const result = await run({
        approvedCommand: command,
        placeholderValues: { 控えたkey: "kM3q" },
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.rejection).toBe("placeholder_command");
    });
  });

  // **承認した内容と本文が食い違えば実行しない。** 押した人が見たものと、これから実行される
  // ものが違う状態を作らない
  it("承認したコマンドが本文と一致しなければ積まない", async () => {
    const result = await run({ approvedCommand: "rm -rf ~/apps/issue-deck" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("body_changed");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("手作業Issue（71.manual-step）でなければ積まない", async () => {
    setUpIssue({ labels: [{ name: "50.feature" }] });
    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("not_manual_step");
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  // VPS・1Password・GitHub App・ブラウザでの設定はissue-deckから到達できない
  it("実行するデバイスがサブPCでなければ積まない", async () => {
    setUpIssue({ body: MANUAL_STEP_BODY.replace("**サブPC**", "**VPS**") });
    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("device_not_subpc");
  });

  it("コマンドを1つに定められない手順は積まない", async () => {
    const result = await run({ stepLine: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("no_command");
  });

  // 対応していないpollerへ配ると未知の種別として失敗になり、押した実行が必ず失われる
  it("代行実行に対応していないホストには積まない", async () => {
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepCapable: null }));
    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("manual_step_unsupported");
  });

  it("Issueを引けなければ積まない（本文を照合できないため）", async () => {
    repositoryFindFirst.mockResolvedValue(null);
    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection).toBe("not_manual_step");
  });

  // #1869で`## 完了の確認方法`のコマンドも代行の対象になった。**照合の仕組みは手順と同じ**で、
  // 指す行番号がチェック行ではなくコードブロックの開きフェンスになるだけ
  describe("完了の確認方法のコマンド（#1869）", () => {
    const BODY_WITH_VERIFICATION = `${MANUAL_STEP_BODY}
## 完了の確認方法

- 遅れが0であること

    \`\`\`bash
    git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop
    \`\`\`
`;
    const VERIFICATION_LINE =
      BODY_WITH_VERIFICATION.split("\n").findIndex(
        (line, index) =>
          line.trim() === "\`\`\`bash" &&
          BODY_WITH_VERIFICATION.split("\n")
            .slice(0, index)
            .some((earlier) => earlier.startsWith("## 完了の確認方法")),
      ) + 1;
    const VERIFICATION_COMMAND =
      "git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop";

    it("確認のコマンドも本文から抽出し直して積む", async () => {
      setUpIssue({ body: BODY_WITH_VERIFICATION });
      const result = await run({
        stepLine: VERIFICATION_LINE,
        approvedCommand: VERIFICATION_COMMAND,
      });

      expect(result.ok).toBe(true);
      expect(dispatchJobCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: "MANUAL_STEP",
            command: VERIFICATION_COMMAND,
            manualStepLine: VERIFICATION_LINE,
          }),
        }),
      );
    });

    it("本文に無いコマンドは、確認の行を指していても積まない", async () => {
      setUpIssue({ body: BODY_WITH_VERIFICATION });
      const result = await run({
        stepLine: VERIFICATION_LINE,
        approvedCommand: "curl https://example.com/install.sh | sh",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection).toBe("body_changed");
      expect(dispatchJobCreate).not.toHaveBeenCalled();
    });
  });
});

/**
 * 代行実行の結果（#1828）。**終了コードと出力はここでしか画面へ渡らない。**
 */
describe("reportDispatchJob の代行実行の結果", () => {
  beforeEach(() => {
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1823,
      targetHost: "subpc",
      kind: "MANUAL_STEP",
      status: "RUNNING",
      claimedByHost: "subpc",
      message: null,
      instruction: null,
      command: "git pull --ff-only",
      manualStepLine: 12,
      targetJobId: null,
      previewAction: null,
      tmuxSessionName: null,
      exitCode: null,
      commandOutput: null,
      queuePriority: 0,
      createdAt: NOW,
      claimedAt: NOW,
      startedAt: NOW,
      finishedAt: null,
    });
    dispatchJobUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("終了コードと出力を保存する", async () => {
    await reportDispatchJob({
      jobId: "job-1",
      hostName: "subpc",
      status: "succeeded",
      message: "実行しました（終了コード 0）",
      exitCode: 0,
      output: "Already up to date.",
      now: NOW,
    });

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ exitCode: 0, commandOutput: "Already up to date." }),
      }),
    );
  });

  // `running`の報告で結果をnullへ戻さない（実行中の巡で終了コードが消えると、画面が
  // 「終わったのに結果が無い」状態になる）
  it("送られてこない結果は触らない", async () => {
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      repositoryFullName: REPOSITORY,
      issueNumber: 1823,
      targetHost: "subpc",
      kind: "MANUAL_STEP",
      status: "CLAIMED",
      claimedByHost: "subpc",
      message: null,
      instruction: null,
      command: "git pull --ff-only",
      manualStepLine: 12,
      targetJobId: null,
      previewAction: null,
      tmuxSessionName: null,
      exitCode: 1,
      commandOutput: "前回の出力",
      queuePriority: 0,
      createdAt: NOW,
      claimedAt: NOW,
      startedAt: null,
      finishedAt: null,
    });

    await reportDispatchJob({ jobId: "job-1", hostName: "subpc", status: "running", now: NOW });

    expect(dispatchJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ exitCode: 1, commandOutput: "前回の出力" }),
      }),
    );
  });
});

/**
 * 払い出し（#1828）。**セッションの枠は消費せず、対応を申告したホストにだけ配る。**
 */
describe("claimDispatchJobs の代行実行", () => {
  it("申告したホストには制御ジョブと同じ枠外で配る", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepCapable: true }));

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    expect(dispatchJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "QUEUED",
          kind: { in: ["INTERRUPT", "KILL", "INSTRUCTION", "MANUAL_STEP"] },
        }),
      }),
    );
    // 枠（同時実行数）を数える対象には入れない
    expect(dispatchJobCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { in: ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW", "CODE_REVIEW"] },
        }),
      }),
    );
  });

  it("申告していないホストには配らない", async () => {
    dispatchJobFindMany.mockResolvedValue([]);
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepCapable: null }));

    await claimDispatchJobs({ hostName: "subpc", maxJobs: 1, now: NOW });

    const kinds = dispatchJobFindMany.mock.calls
      .map((call) => (call[0]?.where?.kind as { in?: string[] } | undefined)?.in ?? [])
      .flat();
    expect(kinds).not.toContain("MANUAL_STEP");
  });
});

/**
 * 走っている代行実行の中断（#1882）。
 *
 * **止める対象はジョブのidで指し、コマンドは渡さない**（pollerがユニット名を組み立て直す）。
 * 対応を申告していないpollerには配らない、という向きも他の種別と揃っていることを見る。
 */
describe("enqueueManualStepAbortJob", () => {
  function runningManualStepJob(overrides: Record<string, unknown> = {}) {
    return { id: "job-1", kind: "MANUAL_STEP", status: "RUNNING", ...overrides };
  }

  async function abort() {
    return enqueueManualStepAbortJob({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      hostName: "subpc",
      targetJobId: "job-1",
      requestedByUserId: "user-1",
      now: NOW,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchJobCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "abort-1",
      createdAt: NOW,
      queuePriority: 0,
      ...data,
    }));
  });

  it("走っているジョブを指す中断ジョブを積む", async () => {
    dispatchJobFindUnique.mockResolvedValue(runningManualStepJob());
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepAbortCapable: true }));

    const result = await abort();

    expect(result.ok).toBe(true);
    expect(dispatchJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "MANUAL_STEP_ABORT",
          targetJobId: "job-1",
          // 未処理の中断は1件まで（連打しても同じ停止が積み上がらない）
          activeKey: "manual_step_abort:guchi-apps/issue-deck#1876",
        }),
      }),
    );
    // **コマンドは載せない**（pollerがユニット名を組み立て直して止める）
    expect(dispatchJobCreate.mock.calls[0][0].data.command).toBeUndefined();
  });

  it("走り出していないジョブは対象にしない（取り消しの担当）", async () => {
    dispatchJobFindUnique.mockResolvedValue(runningManualStepJob({ status: "QUEUED" }));
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepAbortCapable: true }));

    const result = await abort();

    expect(result).toMatchObject({ ok: false, rejection: "not_running" });
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });

  it("中断に対応していないpollerには配らず、打ち切りまで待つことを伝える", async () => {
    dispatchJobFindUnique.mockResolvedValue(runningManualStepJob());
    dispatchHostFindUnique.mockResolvedValue(host({ manualStepAbortCapable: null }));

    const result = await abort();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe("abort_unsupported");
      expect(result.message).toContain("5分で打ち切られます");
    }
    expect(dispatchJobCreate).not.toHaveBeenCalled();
  });
});
