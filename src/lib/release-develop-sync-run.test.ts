import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mainHead: vi.fn(),
  branchHead: vi.fn(),
  compare: vi.fn(),
  openPrs: vi.fn(),
  closedPrs: vi.fn(),
  ciState: vi.fn(),
  createRef: vi.fn(),
  createPr: vi.fn(),
  merge: vi.fn(),
  enableAutoMerge: vi.fn(),
  disableAutoMerge: vi.fn(),
  callerText: vi.fn(async () => null as string | null),
  fileText: vi.fn(async () => null as string | null),
  candidateFindMany: vi.fn(),
  repositoryFindFirst: vi.fn(),
  productionCheckFindFirst: vi.fn(async () => null as { mergeSha: string } | null),
  commitSummary: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    releaseCandidate: { findMany: mocks.candidateFindMany },
    repository: { findFirst: mocks.repositoryFindFirst },
    releaseProductionCheck: { findFirst: mocks.productionCheckFindFirst },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/actions-api", () => ({
  mergePullRequest: mocks.merge,
  enablePullRequestAutoMerge: mocks.enableAutoMerge,
  disablePullRequestAutoMerge: mocks.disableAutoMerge,
}));
vi.mock("@/lib/github/branches-api", () => ({ compareBranches: mocks.compare }));
vi.mock("@/lib/github/release-api", () => ({
  createBranchRef: mocks.createRef,
  createPullRequest: mocks.createPr,
  fetchBranchHeadSha: mocks.branchHead,
  fetchCommitSummary: mocks.commitSummary,
  fetchFileTextAtRef: mocks.fileText,
  fetchMainHeadSha: mocks.mainHead,
  fetchOpenPullRequestsForBase: mocks.openPrs,
  fetchPullRequestCiState: mocks.ciState,
  fetchRecentClosedPullRequestsForBase: mocks.closedPrs,
  fetchReleaseCallerText: mocks.callerText,
}));

import { developSyncMarker } from "@/lib/release-develop-sync";
import {
  developSyncAutoMergeOutlook,
  ensureDevelopSync,
  observeDevelopSync,
  resetDevelopSyncStateForTest,
  runDevelopSyncSweep,
} from "@/lib/release-develop-sync-run";

const ctx = { owner: "o", repo: "r", token: "t" };
const MAIN = "a".repeat(40);
const DEV = "b".repeat(40);
const OLD_MAIN = "c".repeat(40);
const files = (names: string[]) => names.map((filename) => ({ filename, status: "modified", sha: "x", previousFilename: null }));
const diverged = { aheadBy: 5, behindBy: 15, changedFiles: 2, lastCommitAt: null, files: files(["package.json", "src/lib/changelog.ts"]) };

beforeEach(() => {
  vi.clearAllMocks();
  resetDevelopSyncStateForTest();
  mocks.mainHead.mockResolvedValue(MAIN);
  mocks.branchHead.mockResolvedValue(DEV);
  mocks.compare.mockResolvedValue(diverged);
  mocks.openPrs.mockResolvedValue([]);
  mocks.closedPrs.mockResolvedValue([]);
  mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true });
  mocks.createRef.mockResolvedValue("created");
  mocks.createPr.mockResolvedValue({ number: 70, html_url: "u" });
  mocks.merge.mockResolvedValue({ sha: "m" });
  mocks.productionCheckFindFirst.mockResolvedValue(null);
});

describe("observeDevelopSync", () => {
  it("記録に依らずGit履歴で判定する（mainがdevelopに含まれれば同期済み、同期PRは探さない）", async () => {
    mocks.compare.mockResolvedValue({ aheadBy: 0, behindBy: 3, changedFiles: 0, lastCommitAt: null, files: [] });
    expect(await observeDevelopSync(ctx)).toMatchObject({ kind: "observed", mainInDevelop: true });
    expect(mocks.compare).toHaveBeenCalledWith("o", "r", DEV, MAIN, "t");
    expect(mocks.openPrs).not.toHaveBeenCalled();
  });

  it("developの先端・差分・同期PRを取れなければ判定不能にする（同期済みと推定しない）", async () => {
    mocks.branchHead.mockResolvedValueOnce(null);
    expect(await observeDevelopSync(ctx)).toMatchObject({ kind: "unreadable" });
    mocks.branchHead.mockRejectedValueOnce(new Error("502"));
    expect(await observeDevelopSync(ctx)).toMatchObject({ kind: "unreadable" });
    mocks.compare.mockResolvedValueOnce(null);
    expect(await observeDevelopSync(ctx)).toMatchObject({ kind: "unreadable" });
    mocks.closedPrs.mockRejectedValueOnce(new Error("502"));
    expect(await observeDevelopSync(ctx)).toMatchObject({ kind: "unreadable" });
  });

  it("squashでマージした同期PRの後にmainへ変更が無ければ、それで同期済みとする", async () => {
    mocks.closedPrs.mockResolvedValue([
      { number: 60, merged_at: "2026-10-13T00:00:00Z", head: { ref: "release-sync/main-cccccccccccc", sha: "s" }, body: developSyncMarker(OLD_MAIN), html_url: "u", title: "t" },
    ]);
    // 同期した時点のmain → 今のmainは、マージコミットだけ（変更ファイル0）
    mocks.compare.mockImplementation(async (_o: string, _r: string, base: string) =>
      base === OLD_MAIN ? { aheadBy: 1, behindBy: 0, changedFiles: 0, lastCommitAt: null, files: [] } : diverged,
    );
    expect(await observeDevelopSync(ctx)).toMatchObject({ squashCoveredBy: 60 });
  });

  it("開いている同期PRの競合・CIを読む（以前のhead=mainの同期PRも同期PRとして扱う）", async () => {
    mocks.openPrs.mockResolvedValue([{ number: 41, head: { ref: "main", sha: MAIN }, body: null, html_url: "u41" }]);
    mocks.ciState.mockResolvedValue({ ciState: "pending", mergeable: false });
    expect(await observeDevelopSync(ctx)).toMatchObject({
      openPullRequest: { number: 41, headRef: "main", mainSha: null, ciState: "pending", mergeable: false },
    });
  });
});

describe("ensureDevelopSync", () => {
  it("未同期で同期PRが無ければ、mainの先端から専用ブランチを切ってdevelop向けPRを作る（mainはheadにしない）", async () => {
    mocks.openPrs.mockResolvedValueOnce([]).mockResolvedValue([
      { number: 70, head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: MAIN }, body: developSyncMarker(MAIN), html_url: "u70" },
    ]);
    const status = await ensureDevelopSync(ctx);
    expect(mocks.createRef).toHaveBeenCalledWith("o", "r", "release-sync/main-aaaaaaaaaaaa", MAIN, "t");
    const input = mocks.createPr.mock.calls[0][3];
    expect(input).toMatchObject({ base: "develop", head: "release-sync/main-aaaaaaaaaaaa" });
    expect(input.body).toContain(developSyncMarker(MAIN));
    expect(input.body).toContain("`package.json`");
    expect(status).toMatchObject({ state: "unsynced", detail: "awaiting_merge", pullRequest: { number: 70 } });
  });

  it("同期済み・同期PRが開いている間は作らない（重複巡回でPRを増やさない）", async () => {
    mocks.compare.mockResolvedValue({ aheadBy: 0, behindBy: 1, changedFiles: 0, lastCommitAt: null, files: [] });
    expect(await ensureDevelopSync(ctx)).toMatchObject({ state: "synced" });
    mocks.compare.mockResolvedValue(diverged);
    mocks.openPrs.mockResolvedValue([{ number: 70, head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: MAIN }, body: developSyncMarker(MAIN), html_url: "u70" }]);
    expect(await ensureDevelopSync(ctx)).toMatchObject({ state: "unsynced", pullRequest: { number: 70 } });
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.createRef).not.toHaveBeenCalled();
  });

  it("判定不能のときは作らず、判定不能のまま返す", async () => {
    mocks.compare.mockResolvedValue(null);
    expect(await ensureDevelopSync(ctx)).toMatchObject({ state: "unknown" });
    expect(mocks.createPr).not.toHaveBeenCalled();
  });

  it("作成に失敗しても例外にせず理由を残し、次の呼び出しで再試行する", async () => {
    mocks.createPr.mockRejectedValueOnce(new Error("GitHub API request failed: 403"));
    const failed = await ensureDevelopSync(ctx);
    expect(failed).toMatchObject({ state: "unsynced", detail: "create_failed", canCreate: true });
    expect(failed.reason).toContain("403");
    // 画面の読み込み（観測だけ）にも理由が出る
    expect(await observeDevelopSync(ctx)).toMatchObject({ createFailure: expect.stringContaining("403") });
    await ensureDevelopSync(ctx);
    expect(mocks.createPr).toHaveBeenCalledTimes(2);
    expect(await observeDevelopSync(ctx)).toMatchObject({ createFailure: null });
  });
});

describe("同期PRの自動マージ（#4669）", () => {
  const settled = { state: "settled", step: null, runUrl: null, aiReview: { state: "passed", runUrl: null } };
  const openSync = () =>
    mocks.openPrs.mockResolvedValue([{ number: 70, head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: MAIN }, body: developSyncMarker(MAIN), labels: [], html_url: "u70" }]);

  it("競合なし・CI成功・自動レビュー完了なら、HEADを指定してマージする（巡回だけ）", async () => {
    openSync();
    mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true, mergeJudgement: settled });
    await ensureDevelopSync(ctx);
    expect(mocks.merge).not.toHaveBeenCalled();
    await ensureDevelopSync(ctx, { autoMerge: true });
    expect(mocks.merge).toHaveBeenCalledWith("o", "r", 70, "t", MAIN);
  });

  it("コードを含む同期PR（#4730のようなRC上の修正）もマージする", async () => {
    openSync();
    mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true, mergeJudgement: settled });
    mocks.compare.mockResolvedValue({ ...diverged, files: files(["package.json", "src/lib/public-http-fetch.ts"]) });
    await ensureDevelopSync(ctx, { autoMerge: true });
    expect(mocks.merge).toHaveBeenCalledWith("o", "r", 70, "t", MAIN);
  });

  it.each([
    ["レビュー判定が未完了", { ciState: "success", mergeable: true, mergeJudgement: { ...settled, state: "pending" } }],
    ["判定が取れない", { ciState: "success", mergeable: true }],
    ["CI実行中", { ciState: "pending", mergeable: true, mergeJudgement: settled }],
    ["競合", { ciState: "success", mergeable: false, mergeJudgement: settled }],
    ["マージ可否未確定", { ciState: "success", mergeable: null, mergeJudgement: settled }],
  ])("%sならマージしない", async (_name, ci) => {
    openSync();
    mocks.ciState.mockResolvedValue(ci);
    await ensureDevelopSync(ctx, { autoMerge: true });
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("追いコミット済み・mainが進んだ・既知外のファイル（ワークフロー等）を含む同期PRは人へ回す", async () => {
    mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true, mergeJudgement: settled });
    mocks.openPrs.mockResolvedValue([{ number: 70, head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: "h".repeat(40) }, body: developSyncMarker(MAIN), labels: [], html_url: "u" }]);
    await ensureDevelopSync(ctx, { autoMerge: true });
    mocks.openPrs.mockResolvedValue([{ number: 70, head: { ref: "release-sync/main-cccccccccccc", sha: OLD_MAIN }, body: developSyncMarker(OLD_MAIN), labels: [], html_url: "u" }]);
    await ensureDevelopSync(ctx, { autoMerge: true });
    openSync();
    mocks.compare.mockResolvedValue({ ...diverged, files: files(["package.json", ".github/workflows/ci.yml"]) });
    await ensureDevelopSync(ctx, { autoMerge: true });
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  describe("ワークフローを含む同期PR（#5081）", () => {
    const PARENT = "d".repeat(40);
    const withWorkflow = { ...diverged, files: files(["package.json", ".github/workflows/collection-daily.yml"]) };
    beforeEach(() => {
      openSync();
      mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true, mergeJudgement: settled });
      mocks.commitSummary.mockResolvedValue({ message: "Merge", parents: [PARENT, "e".repeat(40)] });
      // develop...main は差分あり、親...main（公開のマージで変わったファイル）は呼び出しの引数で分ける
      mocks.compare.mockImplementation(async (_o: string, _r: string, base: string) =>
        base === PARENT ? { aheadBy: 1, behindBy: 0, changedFiles: 2, lastCommitAt: null, files: files(["package.json", ".github/workflows/collection-daily.yml"]) } : withWorkflow,
      );
    });

    it("今のmainがRCの公開で本番へマージした記録と一致し、ワークフローがそのマージで変わったものならマージする", async () => {
      mocks.productionCheckFindFirst.mockResolvedValue({ mergeSha: MAIN });
      await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.productionCheckFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { repositoryFullName: "o/r", mergeSha: MAIN } }));
      expect(mocks.merge).toHaveBeenCalledWith("o", "r", 70, "t", MAIN);
    });

    it("公開の記録が無いmainは人へ回し、理由を一覧へ渡す", async () => {
      const status = await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(status).toMatchObject({ detail: "merge_held", label: "同期PRは人の確認が必要です" });
      expect(status.reason).toContain("記録と一致しません");
      expect(developSyncAutoMergeOutlook("o/r", 70, MAIN)).toMatchObject({ status: "held" });
      // HEADが違えば使わない
      expect(developSyncAutoMergeOutlook("o/r", 70, "f".repeat(40))).toBeNull();
    });

    it("今回の公開で変わっていないワークフロー（以前から未同期）は人へ回す", async () => {
      mocks.productionCheckFindFirst.mockResolvedValue({ mergeSha: MAIN });
      mocks.compare.mockImplementation(async (_o: string, _r: string, base: string) =>
        base === PARENT ? { aheadBy: 1, behindBy: 0, changedFiles: 1, lastCommitAt: null, files: files(["package.json"]) } : withWorkflow,
      );
      const status = await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(status.reason).toContain("以前から未同期");
    });

    it("公開のマージで変わったファイルを取れないときはマージせず、理由付きで人へ回す", async () => {
      mocks.productionCheckFindFirst.mockResolvedValue({ mergeSha: MAIN });
      mocks.commitSummary.mockRejectedValue(new Error("502"));
      const status = await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(status.detail).toBe("merge_held");
      expect(status.reason).toContain("照合できません");
      expect(developSyncAutoMergeOutlook("o/r", 70, MAIN)).toMatchObject({ status: "held" });
    });

    it("ワークフローを含まない同期PRでは記録を引かない", async () => {
      mocks.compare.mockResolvedValue(diverged);
      await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.productionCheckFindFirst).not.toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalled();
    });
  });

  describe("GitHubのオートマージ（#5146）", () => {
    const reviewDoneCiRunning = { ...settled, state: "pending", step: "wait-for-ci" };
    const syncPr = (over: Record<string, unknown> = {}) => ({
      number: 70,
      node_id: "PR_70",
      head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: MAIN },
      body: developSyncMarker(MAIN),
      labels: [],
      html_url: "u70",
      auto_merge: null,
      ...over,
    });

    it("CIの実行中は、レビューが終わっていてもオートマージを有効にせず、巡回でも直接マージしない（#5151）", async () => {
      mocks.openPrs.mockResolvedValue([syncPr()]);
      mocks.ciState.mockResolvedValue({ ciState: "pending", mergeable: true, mergeJudgement: reviewDoneCiRunning });
      const status = await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.enableAutoMerge).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(status.detail).toBe("ci_pending");
    });

    it("以前の版が有効にしたオートマージがCIの実行中に残っていれば、確認ラベルが無くても解除する（#5151）", async () => {
      mocks.ciState.mockResolvedValue({ ciState: "pending", mergeable: true, mergeJudgement: reviewDoneCiRunning });
      mocks.openPrs.mockResolvedValue([syncPr({ auto_merge: { enabled_by: { login: "issue-deck[bot]", type: "Bot" } } })]);
      await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.disableAutoMerge).toHaveBeenCalledWith("PR_70", "t");
      expect(mocks.enableAutoMerge).not.toHaveBeenCalled();
    });

    it("人の対応が要る判定に変わったら、IssueDeckが有効にしたものだけ解除する", async () => {
      mocks.ciState.mockResolvedValue({ ciState: "pending", mergeable: true, mergeJudgement: reviewDoneCiRunning });
      mocks.openPrs.mockResolvedValue([syncPr({ labels: [{ name: "00.check-user" }], auto_merge: { enabled_by: { login: "issue-deck[bot]", type: "Bot" } } })]);
      expect(await ensureDevelopSync(ctx, { autoMerge: true })).toMatchObject({ detail: "merge_held" });
      expect(mocks.disableAutoMerge).toHaveBeenCalledWith("PR_70", "t");
      mocks.disableAutoMerge.mockClear();
      mocks.openPrs.mockResolvedValue([syncPr({ labels: [{ name: "00.check-user" }], auto_merge: { enabled_by: { login: "someone", type: "User" } } })]);
      await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.disableAutoMerge).not.toHaveBeenCalled();
    });

    it("追いコミットでHEADがmainの先端と食い違ったら解除し、解除に失敗しても次の巡回でやり直す", async () => {
      mocks.ciState.mockResolvedValue({ ciState: "pending", mergeable: true, mergeJudgement: reviewDoneCiRunning });
      mocks.openPrs.mockResolvedValue([syncPr({ head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: "h".repeat(40) }, auto_merge: { enabled_by: { type: "Bot" } } })]);
      mocks.disableAutoMerge.mockRejectedValueOnce(new Error("502"));
      await ensureDevelopSync(ctx, { autoMerge: true });
      await ensureDevelopSync(ctx, { autoMerge: true });
      expect(mocks.disableAutoMerge).toHaveBeenCalledTimes(2);
      expect(mocks.enableAutoMerge).not.toHaveBeenCalled();
    });
  });

  it("人の確認ラベルがある・旧head=mainの同期PRはマージしない。マージ失敗でも例外にしない", async () => {
    mocks.ciState.mockResolvedValue({ ciState: "success", mergeable: true, mergeJudgement: settled });
    mocks.openPrs.mockResolvedValue([
      { number: 70, head: { ref: "release-sync/main-aaaaaaaaaaaa", sha: "h" }, body: null, labels: [{ name: "00.check-user" }], html_url: "u" },
    ]);
    await ensureDevelopSync(ctx, { autoMerge: true });
    mocks.openPrs.mockResolvedValue([{ number: 41, head: { ref: "main", sha: MAIN }, body: null, labels: [], html_url: "u" }]);
    await ensureDevelopSync(ctx, { autoMerge: true });
    expect(mocks.merge).not.toHaveBeenCalled();
    openSync();
    mocks.merge.mockRejectedValueOnce(new Error("405"));
    expect(await ensureDevelopSync(ctx, { autoMerge: true })).toMatchObject({ state: "unsynced", detail: "awaiting_merge" });
  });
});

describe("runDevelopSyncSweep", () => {
  it("候補を使ったリポジトリを、候補の段階に関係なく巡回し、間隔内は重ねて確かめない", async () => {
    mocks.candidateFindMany.mockResolvedValue([{ repositoryFullName: "o/r" }]);
    mocks.repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
    const first = await runDevelopSyncSweep(1_000_000);
    expect(first).toMatchObject({ checked: 1, unsynced: ["o/r"] });
    expect(mocks.createPr).toHaveBeenCalledTimes(1);
    expect(await runDevelopSyncSweep(1_000_000 + 60_000)).toMatchObject({ checked: 0 });
  });
});
