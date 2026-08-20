import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 完了の確認方法の定期巡回（#2008）。
 *
 * 見るのは**何を選ぶか・何を積むか・どこで結論を出すか**だけ。対象の判定は
 * `manual-step-verification.test.ts`が、ジョブの積み方は`dispatch/jobs.test.ts`が見ている。
 */

const checkFindMany = vi.fn();
const checkFindUnique = vi.fn();
const checkUpsert = vi.fn();
const checkUpdate = vi.fn();
const dispatchHostFindMany = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchJobFindUnique = vi.fn();
const issueFindMany = vi.fn();
const issueFindFirst = vi.fn();
const repositoryFindFirst = vi.fn();
const manualStepRunFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    manualStepVerificationCheck: {
      get findMany() {
        return checkFindMany;
      },
      get findUnique() {
        return checkFindUnique;
      },
      get upsert() {
        return checkUpsert;
      },
      get update() {
        return checkUpdate;
      },
    },
    dispatchHost: {
      get findMany() {
        return dispatchHostFindMany;
      },
    },
    dispatchJob: {
      get findMany() {
        return dispatchJobFindMany;
      },
      get findUnique() {
        return dispatchJobFindUnique;
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
    repository: {
      get findFirst() {
        return repositoryFindFirst;
      },
    },
    manualStepRun: {
      get findMany() {
        return manualStepRunFindMany;
      },
    },
  },
}));

const enqueueManualStepJob = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({
  enqueueManualStepJob: (...args: unknown[]) => enqueueManualStepJob(...args),
}));

/**
 * **テストごとにモジュールを読み込み直す。** 巡回は「次の候補を探し直す間隔」をプロセス内の
 * 変数で持っており（`CANDIDATE_SEARCH_INTERVAL_MS`）、読み込みを共有すると2件目以降の
 * テストが同じ時刻で間引かれる。
 */
type PatrolModule = typeof import("@/lib/manual-step-verification-patrol");
let patrol: PatrolModule;

const NOW = new Date("2026-08-20T09:00:00.000Z");
const REPOSITORY = "guchi-apps/issue-deck";

/** 確認コマンドが2件ある手作業Issueの本文（1件目が18行目、2件目が22行目） */
const BODY = [
  "## 前提条件", // 1
  "", // 2
  "- 実行するデバイス: **サブPC**（`ssh subpc`）", // 3
  "", // 4
  "## やること", // 5
  "", // 6
  "- [ ] pollerを入れ替える", // 7
  "", // 8
  "  ```bash", // 9
  "  systemctl --user restart issue-deck-dispatch-poller.service", // 10
  "  ```", // 11
  "", // 12
  "## 完了の確認方法", // 13
  "", // 14
  "```bash", // 15
  "systemctl --user is-active issue-deck-dispatch-poller.service", // 16
  "```", // 17
  "", // 18
  "```bash", // 19
  "cat /home/guchi/apps/issue-deck/README.md", // 20
  "```", // 21
].join("\n");

const VERIFICATION_LINES = [15, 19];

function issueRow(overrides: { number?: number; body?: string } = {}) {
  return {
    number: overrides.number ?? 1994,
    body: overrides.body ?? BODY,
    repository: { fullName: REPOSITORY },
  };
}

function checkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "check-1",
    repositoryFullName: REPOSITORY,
    issueNumber: 1994,
    targetHost: "subpc",
    status: "RUNNING",
    doneLines: "[]",
    currentJobId: null,
    message: null,
    startedAt: NOW,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  patrol = await import("@/lib/manual-step-verification-patrol");
  checkFindMany.mockResolvedValue([]);
  checkFindUnique.mockResolvedValue(null);
  checkUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) =>
    checkRow(create),
  );
  checkUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    checkRow(data),
  );
  dispatchHostFindMany.mockResolvedValue([
    { name: "subpc", manualStepCapable: true, lastSeenAt: NOW },
  ]);
  dispatchJobFindMany.mockResolvedValue([]);
  issueFindMany.mockResolvedValue([issueRow()]);
  issueFindFirst.mockResolvedValue({
    body: BODY,
    state: "OPEN",
    labels: [{ name: "71.manual-step" }],
  });
  repositoryFindFirst.mockResolvedValue({ id: "repo-1" });
  manualStepRunFindMany.mockResolvedValue([]);
  enqueueManualStepJob.mockResolvedValue({ ok: true, job: { id: "job-1" } });
});

describe("runManualStepVerificationPatrol", () => {
  it("`## 完了の確認方法`のコマンドだけを、先頭の1件から積む", async () => {
    await patrol.runManualStepVerificationPatrol(NOW);

    expect(enqueueManualStepJob).toHaveBeenCalledTimes(1);
    expect(enqueueManualStepJob).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: REPOSITORY,
        issueNumber: 1994,
        hostName: "subpc",
        stepLine: VERIFICATION_LINES[0],
        // **押した人が居ない**（巡回が積んだ1件であることの印）
        requestedByUserId: null,
      }),
    );
    // `## やること`の手順（10行目のrestart）は積まない
    expect(enqueueManualStepJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ stepLine: 7 }),
    );
  });

  it("代行実行を申告して応答しているホストが居なければ何もしない", async () => {
    dispatchHostFindMany.mockResolvedValue([
      { name: "subpc", manualStepCapable: true, lastSeenAt: new Date("2026-08-19T00:00:00.000Z") },
    ]);

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpsert).not.toHaveBeenCalled();
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("走っている巡回があるうちは、次のIssueを始めない", async () => {
    checkFindMany.mockResolvedValue([checkRow({ currentJobId: "job-1" })]);
    dispatchJobFindUnique.mockResolvedValue({ id: "job-1", status: "RUNNING" });

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpsert).not.toHaveBeenCalled();
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("1件目が成功したら2件目を積む", async () => {
    checkFindMany.mockResolvedValue([checkRow({ currentJobId: "job-1" })]);
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      status: "SUCCEEDED",
      exitCode: 0,
      manualStepLine: VERIFICATION_LINES[0],
    });
    checkUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      checkRow({ currentJobId: null, doneLines: JSON.stringify(VERIFICATION_LINES.slice(0, 1)), ...data }),
    );

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(enqueueManualStepJob).toHaveBeenCalledWith(
      expect.objectContaining({ stepLine: VERIFICATION_LINES[1] }),
    );
  });

  it("全部が終了コード0で終わったらPASSED（＝完了済みの可能性）にする", async () => {
    checkFindMany.mockResolvedValue([
      checkRow({ doneLines: JSON.stringify(VERIFICATION_LINES) }),
    ]);

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PASSED", finishedAt: NOW }),
      }),
    );
    // 積むものはもう無い
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("0以外で終わったらFAILEDにして、残りの確認コマンドは流さない", async () => {
    checkFindMany.mockResolvedValue([checkRow({ currentJobId: "job-1" })]);
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      status: "SUCCEEDED",
      exitCode: 1,
      manualStepLine: VERIFICATION_LINES[0],
    });

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("24時間以内に巡回したIssueは選び直さない", async () => {
    checkFindUnique.mockResolvedValue(null);
    checkFindMany.mockResolvedValue([]);
    // 選定のための一括取得（`status`の絞り込みが無い方）で返す
    checkFindMany.mockImplementation(async (args: { where?: { status?: string } }) =>
      args.where?.status === "RUNNING"
        ? []
        : [
            checkRow({
              status: "FAILED",
              finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
            }),
          ],
    );

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpsert).not.toHaveBeenCalled();
  });

  it("人の自動実行が動いているIssueは選ばない", async () => {
    manualStepRunFindMany.mockResolvedValue([
      { repositoryFullName: REPOSITORY, issueNumber: 1994 },
    ]);

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpsert).not.toHaveBeenCalled();
  });

  it("未処理のジョブが積まれているIssueは選ばない", async () => {
    dispatchJobFindMany.mockResolvedValue([{ activeKey: `${REPOSITORY}#1994` }]);

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpsert).not.toHaveBeenCalled();
  });

  it("積めなかったらUNAVAILABLEで終える（翌日やり直す）", async () => {
    enqueueManualStepJob.mockResolvedValue({
      ok: false,
      rejection: "host_offline",
      message: "起動先が応答していません。",
    });

    await patrol.runManualStepVerificationPatrol(NOW);

    expect(checkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNAVAILABLE" }),
      }),
    );
  });
});

describe("abandonManualStepVerificationCheck", () => {
  it("人が自動実行を始めたら、走っている巡回をやめる", async () => {
    checkFindUnique.mockResolvedValue(checkRow({ currentJobId: "job-1" }));

    await patrol.abandonManualStepVerificationCheck({
      repositoryFullName: REPOSITORY,
      issueNumber: 1994,
      now: NOW,
    });

    expect(checkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNAVAILABLE", finishedAt: NOW }),
      }),
    );
  });

  it("巡回していなければ何もしない", async () => {
    checkFindUnique.mockResolvedValue(null);

    await patrol.abandonManualStepVerificationCheck({
      repositoryFullName: REPOSITORY,
      issueNumber: 1994,
    });

    expect(checkUpdate).not.toHaveBeenCalled();
  });
});

describe("listManualStepVerifiedAtByIssue", () => {
  it("通ったIssueだけを`owner/repo#番号`で引ける形にする", async () => {
    const finishedAt = new Date("2026-08-20T08:00:00.000Z");
    checkFindMany.mockResolvedValue([
      { repositoryFullName: REPOSITORY, issueNumber: 1994, finishedAt },
    ]);

    const map = await patrol.listManualStepVerifiedAtByIssue();

    expect(map.get(`${REPOSITORY}#1994`)).toEqual(finishedAt);
  });
});
