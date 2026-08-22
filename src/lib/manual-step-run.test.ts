import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 自動実行をサーバーが進める部分（#1882）。
 *
 * 見るのは**進める条件と止める条件**だけ。実行計画の作り方は`manual-step-autorun.test.ts`が、
 * ジョブの積み方は`dispatch/jobs.test.ts`が見ている。
 */

const manualStepVerificationCheckFindUnique = vi.fn();
const manualStepVerificationCheckUpdate = vi.fn();
const manualStepRunUpsert = vi.fn();
const manualStepRunFindUnique = vi.fn();
const manualStepRunFindMany = vi.fn();
const manualStepRunUpdate = vi.fn();
const manualStepRunUpdateMany = vi.fn();
const dispatchJobFindUnique = vi.fn();
const dispatchJobFindFirst = vi.fn();
const dispatchJobFindMany = vi.fn();
const dispatchHostFindUnique = vi.fn();
const repositoryFindFirst = vi.fn();
const repositoryFindMany = vi.fn();
const issueFindFirst = vi.fn();
const issueFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    manualStepVerificationCheck: {
      // 完了確認の巡回（#2008）は、自動実行を始めたときに取りやめるためだけに触る
      get findUnique() {
        return manualStepVerificationCheckFindUnique;
      },
      get update() {
        return manualStepVerificationCheckUpdate;
      },
    },
    manualStepRun: {
      get upsert() {
        return manualStepRunUpsert;
      },
      get findUnique() {
        return manualStepRunFindUnique;
      },
      get findUniqueOrThrow() {
        return manualStepRunFindUnique;
      },
      get findMany() {
        return manualStepRunFindMany;
      },
      get update() {
        return manualStepRunUpdate;
      },
      get updateMany() {
        return manualStepRunUpdateMany;
      },
    },
    dispatchJob: {
      get findUnique() {
        return dispatchJobFindUnique;
      },
      get findFirst() {
        return dispatchJobFindFirst;
      },
      get findMany() {
        return dispatchJobFindMany;
      },
    },
    dispatchHost: {
      get findUnique() {
        return dispatchHostFindUnique;
      },
    },
    repository: {
      get findFirst() {
        return repositoryFindFirst;
      },
      get findMany() {
        return repositoryFindMany;
      },
    },
    issue: {
      get findFirst() {
        return issueFindFirst;
      },
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

const enqueueManualStepJob = vi.fn();
const enqueueManualStepAbortJob = vi.fn();
const cancelDispatchJob = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({
  enqueueManualStepJob: (...args: unknown[]) => enqueueManualStepJob(...args),
  enqueueManualStepAbortJob: (...args: unknown[]) => enqueueManualStepAbortJob(...args),
  cancelDispatchJob: (...args: unknown[]) => cancelDispatchJob(...args),
}));

const resolveInstallationToken = vi.fn();
vi.mock("@/lib/dispatch/installation-token", () => ({
  resolveInstallationToken: (...args: unknown[]) => resolveInstallationToken(...args),
}));

const updateIssue = vi.fn();
vi.mock("@/lib/github/issues-api", () => ({
  updateIssue: (...args: unknown[]) => updateIssue(...args),
}));

const upsertIssueAndGetDisplay = vi.fn();
vi.mock("@/lib/github/sync-issues", () => ({
  upsertIssueAndGetDisplay: (...args: unknown[]) => upsertIssueAndGetDisplay(...args),
}));

const { advanceManualStepRun, listManualStepRunViews, startManualStepRun, stopManualStepRun } =
  await import("./manual-step-run");

const NOW = new Date("2026-08-18T12:00:00.000Z");
const REPOSITORY = "guchi-apps/issue-deck";

const BODY = `## 前提条件

- 実行するデバイス: **サブPC**（メインPCからなら \`ssh subpc\`）
- カレントディレクトリ: \`~/apps/issue-deck\`

## やること

- [ ] チェックアウトを更新する

    \`\`\`bash
    git pull --ff-only
    \`\`\`

- [ ] pollerを再起動する

    \`\`\`bash
    systemctl --user restart issue-deck-dispatch-poller.service
    \`\`\`

## 完了の確認方法

- 遅れが0であること

    \`\`\`bash
    git rev-list --count HEAD..origin/develop
    \`\`\`
`;

const lines = BODY.split("\n");
const FIRST_LINE = lines.findIndex((text) => text.includes("チェックアウトを更新する")) + 1;
const SECOND_LINE = lines.findIndex((text) => text.includes("pollerを再起動する")) + 1;

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    repositoryFullName: REPOSITORY,
    issueNumber: 1876,
    targetHost: "subpc",
    status: "RUNNING",
    pausedReason: null,
    doneLines: "[]",
    diagnoseConsent: true,
    startedByUserId: "user-1",
    currentJobId: null,
    message: null,
    startedAt: new Date(NOW.getTime() - 60_000),
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 更新後の行は「更新前 ＋ data」で返す（実DBと同じように、続きの処理が読める形にする） */
function applyUpdate(current: Record<string, unknown>) {
  manualStepRunUpdate.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  // 巡回していない状態が既定（自動実行の判定には関わらない）
  manualStepVerificationCheckFindUnique.mockResolvedValue(null);
  repositoryFindFirst.mockResolvedValue({ id: "repo-1" });
  issueFindFirst.mockResolvedValue({
    body: BODY,
    title: "[手作業] サブPC: pollerを更新する",
    githubIssueId: BigInt(42),
    labels: [{ name: "71.manual-step" }],
  });
  dispatchHostFindUnique.mockResolvedValue({
    name: "subpc",
    lastSeenAt: new Date(NOW.getTime() - 30_000),
    manualStepCapable: true,
    manualStepAbortCapable: true,
  });
  repositoryFindMany.mockResolvedValue([{ id: "repo-1", fullName: REPOSITORY }]);
  // 既定は「closeされた手作業Issueは無い」（#2073の片付けが効かない状態）
  issueFindMany.mockResolvedValue([]);
  dispatchJobFindMany.mockResolvedValue([]);
  dispatchJobFindFirst.mockResolvedValue(null);
  enqueueManualStepJob.mockResolvedValue({ ok: true, job: { id: "job-1" } });
  manualStepRunUpdateMany.mockResolvedValue({ count: 1 });
});

describe("startManualStepRun", () => {
  it("実行の行を作り、先頭の1件を積む", async () => {
    const created = run();
    manualStepRunUpsert.mockResolvedValue(created);
    applyUpdate(created);
    manualStepRunFindUnique.mockResolvedValue(created);

    const result = await startManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      hostName: "subpc",
      userId: "user-1",
      diagnoseConsent: true,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(enqueueManualStepJob).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: REPOSITORY,
        issueNumber: 1876,
        hostName: "subpc",
        stepLine: FIRST_LINE,
        approvedCommand: "git pull --ff-only",
      }),
    );
    // 積んだジョブを覚える（画面が結果のパネルを引き当てる手掛かり）
    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentJobId: "job-1" }) }),
    );
  });

  it("積めなかったときは理由を添えて止まる", async () => {
    const created = run();
    manualStepRunUpsert.mockResolvedValue(created);
    applyUpdate(created);
    enqueueManualStepJob.mockResolvedValue({
      ok: false,
      rejection: "host_offline",
      message: "subpcが応答していません。",
    });

    await startManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      hostName: "subpc",
      userId: "user-1",
      diagnoseConsent: true,
      now: NOW,
    });

    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAUSED",
          pausedReason: "ENQUEUE_FAILED",
          message: "subpcが応答していません。",
        }),
      }),
    );
  });
});

describe("advanceManualStepRun", () => {
  it("成功したら手順にチェックを付けて次の1件を積む", async () => {
    const current = run({ currentJobId: "job-1" });
    const settled = { ...current, currentJobId: null, doneLines: JSON.stringify([FIRST_LINE]) };
    // 1回目は`findRun`、2回目は決着を付けた後の読み直し（実DBと同じ順で返す）
    manualStepRunFindUnique.mockResolvedValueOnce(current).mockResolvedValue(settled);
    applyUpdate(settled);
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      kind: "MANUAL_STEP",
      status: "SUCCEEDED",
      exitCode: 0,
      manualStepLine: FIRST_LINE,
      message: null,
    });
    resolveInstallationToken.mockResolvedValue("token");
    updateIssue.mockResolvedValue({ number: 1876 });
    // チェックを付けるときはインストール（GitHub App名義）ごと引く
    repositoryFindFirst.mockResolvedValue({ id: "repo-1", installation: { installationId: 1 } });

    await advanceManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      now: NOW,
    });

    // 本文のチェックはGitHub App名義で付ける（押した人がその場に居ないため）
    expect(updateIssue).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      1876,
      "token",
      expect.objectContaining({ body: expect.stringContaining("- [x] チェックアウトを更新する") }),
    );
    expect(enqueueManualStepJob).toHaveBeenCalledWith(
      expect.objectContaining({
        stepLine: SECOND_LINE,
        approvedCommand: "systemctl --user restart issue-deck-dispatch-poller.service",
      }),
    );
  });

  it("失敗したらそこで止まり、次を積まない", async () => {
    const current = run({ currentJobId: "job-1" });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      kind: "MANUAL_STEP",
      status: "FAILED",
      exitCode: 1,
      manualStepLine: FIRST_LINE,
      message: null,
    });

    await advanceManualStepRun({ repositoryFullName: REPOSITORY, issueNumber: 1876, now: NOW });

    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAUSED", pausedReason: "FAILED" }),
      }),
    );
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("代行できない手順に来たら、人の実行を待って止まる", async () => {
    // サブPC以外の手作業＝どの項目も代行できない
    issueFindFirst.mockResolvedValue({
      body: BODY.replace("**サブPC**（メインPCからなら `ssh subpc`）", "**VPS**（`ssh vps`）"),
      title: "[手作業] VPS: 設定を変える",
      githubIssueId: BigInt(42),
      labels: [{ name: "71.manual-step" }],
    });
    const current = run();
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);

    await advanceManualStepRun({ repositoryFullName: REPOSITORY, issueNumber: 1876, now: NOW });

    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAUSED", pausedReason: "USER" }),
      }),
    );
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
  });

  it("流すものが無くなったら終わりにし、クローズはしない", async () => {
    // 手順は両方チェック済み。確認コマンドもこの実行で流し終えている
    const checkedBody = BODY.replace(/- \[ \]/g, "- [x]");
    issueFindFirst.mockResolvedValue({
      body: checkedBody,
      title: "[手作業] サブPC: pollerを更新する",
      githubIssueId: BigInt(42),
      labels: [{ name: "71.manual-step" }],
    });
    const verificationLine =
      checkedBody.split("\n").findIndex((text) => text.includes("git rev-list")) + 1 - 1;
    const current = run({ doneLines: JSON.stringify([verificationLine]) });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);

    await advanceManualStepRun({ repositoryFullName: REPOSITORY, issueNumber: 1876, now: NOW });

    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FINISHED" }) }),
    );
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("この実行で既に成功しているコマンドは積み直さない", async () => {
    const current = run();
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    // 画面から直接積み直して成功していた1件（`doneLines`には載っていない）
    dispatchJobFindMany.mockResolvedValue([{ manualStepLine: FIRST_LINE }]);
    resolveInstallationToken.mockResolvedValue(null);

    await advanceManualStepRun({ repositoryFullName: REPOSITORY, issueNumber: 1876, now: NOW });

    expect(enqueueManualStepJob).toHaveBeenCalledWith(
      expect.objectContaining({ stepLine: SECOND_LINE }),
    );
  });

  it("走っている間は何もしない", async () => {
    const current = run({ currentJobId: "job-1" });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    dispatchJobFindUnique.mockResolvedValue({
      id: "job-1",
      kind: "MANUAL_STEP",
      status: "RUNNING",
      exitCode: null,
      manualStepLine: FIRST_LINE,
      message: null,
    });

    await advanceManualStepRun({ repositoryFullName: REPOSITORY, issueNumber: 1876, now: NOW });

    expect(enqueueManualStepJob).not.toHaveBeenCalled();
    expect(manualStepRunUpdate).not.toHaveBeenCalled();
  });
});

describe("stopManualStepRun", () => {
  it("走っているコマンドには中断ジョブを積む", async () => {
    const current = run({ currentJobId: "job-1" });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    dispatchJobFindUnique.mockResolvedValue({ id: "job-1", kind: "MANUAL_STEP", status: "RUNNING" });
    enqueueManualStepAbortJob.mockResolvedValue({ ok: true, job: { id: "abort-1" } });

    const result = await stopManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      userId: "user-1",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(enqueueManualStepAbortJob).toHaveBeenCalledWith(
      expect.objectContaining({ targetJobId: "job-1", hostName: "subpc" }),
    );
    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED" }) }),
    );
  });

  it("まだ走り出していないコマンドは取り消す", async () => {
    const current = run({ currentJobId: "job-1" });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    dispatchJobFindUnique.mockResolvedValue({ id: "job-1", kind: "MANUAL_STEP", status: "QUEUED" });
    cancelDispatchJob.mockResolvedValue({ ok: true });

    await stopManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      userId: "user-1",
      now: NOW,
    });

    expect(cancelDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }));
    expect(enqueueManualStepAbortJob).not.toHaveBeenCalled();
  });

  it("止められないホストでも中断そのものは成立し、理由を返す", async () => {
    const current = run({ currentJobId: "job-1" });
    manualStepRunFindUnique.mockResolvedValue(current);
    applyUpdate(current);
    dispatchJobFindUnique.mockResolvedValue({ id: "job-1", kind: "MANUAL_STEP", status: "RUNNING" });
    enqueueManualStepAbortJob.mockResolvedValue({
      ok: false,
      rejection: "abort_unsupported",
      message: "subpcのpollerが中断に対応していないため、走っているコマンドは止められません。",
    });

    const result = await stopManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      userId: "user-1",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STOPPED",
          message: expect.stringContaining("中断に対応していない"),
        }),
      }),
    );
  });
});

describe("listManualStepRunViews", () => {
  it("進み具合と、いま流している項目を返す", async () => {
    manualStepRunFindMany.mockResolvedValue([
      run({ status: "PAUSED", pausedReason: "FAILED", doneLines: JSON.stringify([FIRST_LINE]) }),
    ]);

    const [view] = await listManualStepRunViews(NOW);

    expect(view).toMatchObject({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      status: "PAUSED",
      pausedReason: "FAILED",
      done: 1,
      total: 3,
      currentLine: SECOND_LINE,
      issueId: "42",
    });
  });

  /** 終わった実行は返さない（#2073）。描く画面が無くなり、引くだけ無駄になったため */
  it("走っている・止まっている実行だけを引く", async () => {
    manualStepRunFindMany.mockResolvedValue([]);

    await listManualStepRunViews(NOW);

    expect(manualStepRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["RUNNING", "PAUSED"] } } }),
    );
  });

  /**
   * 止まったままの実行の片付け（#2073）。**`PAUSED`は自分では終わらない**ので、Issueだけ
   * closeされると居座り、開いている画面の自動更新が5秒間隔から戻らなくなる。
   */
  it("Issueがcloseされた`PAUSED`の実行は終わりにする", async () => {
    manualStepRunFindMany.mockResolvedValue([run({ status: "PAUSED", pausedReason: "USER" })]);
    issueFindMany.mockResolvedValue([{ repositoryId: "repo-1", number: 1876 }]);

    const [view] = await listManualStepRunViews(NOW);

    expect(manualStepRunUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-1"] } },
      data: expect.objectContaining({ status: "STOPPED", pausedReason: null, finishedAt: NOW }),
    });
    expect(view).toMatchObject({ status: "STOPPED", pausedReason: null });
    expect(view.message).toContain("クローズ");
  });

  it("Issueがopenなら`PAUSED`のままにする", async () => {
    manualStepRunFindMany.mockResolvedValue([run({ status: "PAUSED", pausedReason: "USER" })]);

    const [view] = await listManualStepRunViews(NOW);

    expect(manualStepRunUpdateMany).not.toHaveBeenCalled();
    expect(view).toMatchObject({ status: "PAUSED", pausedReason: "USER" });
  });

  /** 走っている1件を止める段取りは「中断する」の仕事で、ここでは触らない */
  it("`RUNNING`はIssueがcloseされていても片付けない", async () => {
    const running = run({ status: "RUNNING" });
    manualStepRunFindMany.mockResolvedValue([running]);
    applyUpdate(running);
    issueFindMany.mockResolvedValue([{ repositoryId: "repo-1", number: 1876 }]);

    const [view] = await listManualStepRunViews(NOW);

    expect(manualStepRunUpdateMany).not.toHaveBeenCalled();
    expect(view.status).toBe("RUNNING");
  });
});

/**
 * 対話が要るコマンド（#2025）。**そこだけ人へ返し、続きは自動で流せる**ことを見る。
 */
describe("対話が要るコマンドを含む項目", () => {
  const INTERACTIVE_BODY = BODY.replace("git pull --ff-only", "op signin");

  it("対話が要る手順では積まずに人へ返す", async () => {
    const created = run();
    manualStepRunUpsert.mockResolvedValue(created);
    applyUpdate(created);
    issueFindFirst.mockResolvedValue({
      body: INTERACTIVE_BODY,
      title: "[手作業] サブPC: シークレットを同期する",
      githubIssueId: BigInt(42),
      labels: [{ name: "71.manual-step" }],
    });

    await startManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      hostName: "subpc",
      userId: "user-1",
      diagnoseConsent: true,
      now: NOW,
    });

    // 積んでも標準入力が無いまま失敗するだけなので、積まない
    expect(enqueueManualStepJob).not.toHaveBeenCalled();
    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAUSED",
          // ホスト側の事情ではなく、人が実行するしかない止まり方
          pausedReason: "USER",
          message: expect.stringContaining("op signin"),
        }),
      }),
    );
  });

  // 確認コマンドにはチェックが無い（#1869）。記録しないと、続きへ進めても同じ所で止まり続ける
  it("対話が要る確認コマンドは、止まると同時に流し終えた扱いにする", async () => {
    const body = BODY.replace("- [ ] チェックアウトを更新する", "- [x] チェックアウトを更新する")
      .replace("- [ ] pollerを再起動する", "- [x] pollerを再起動する")
      .replace("git rev-list --count HEAD..origin/develop", "op signin");
    const bodyLines = body.split("\n");
    const verificationHeading = bodyLines.findIndex((text) => text.includes("## 完了の確認方法"));
    const verificationLine =
      bodyLines.findIndex((text, index) => index > verificationHeading && text.includes("```bash")) +
      1;

    const created = run();
    manualStepRunUpsert.mockResolvedValue(created);
    applyUpdate(created);
    issueFindFirst.mockResolvedValue({
      body,
      title: "[手作業] サブPC: シークレットを同期する",
      githubIssueId: BigInt(42),
      labels: [{ name: "71.manual-step" }],
    });

    await startManualStepRun({
      repositoryFullName: REPOSITORY,
      issueNumber: 1876,
      hostName: "subpc",
      userId: "user-1",
      diagnoseConsent: true,
      now: NOW,
    });

    expect(enqueueManualStepJob).not.toHaveBeenCalled();
    expect(manualStepRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAUSED",
          pausedReason: "USER",
          doneLines: JSON.stringify([verificationLine]),
        }),
      }),
    );
  });
});
