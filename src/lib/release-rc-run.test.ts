import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  candidateFindUnique: vi.fn(),
  candidateFindFirst: vi.fn(),
  candidateCreate: vi.fn(),
  candidateUpdateMany: vi.fn(async () => ({ count: 1 })),
  candidateUpdate: vi.fn(),
  revisionFindUnique: vi.fn(),
  revisionUpdateMany: vi.fn(async () => ({ count: 1 })),
  revisionFindMany: vi.fn(async () => [] as { prNumber: number | null }[]),
  closeSeries: vi.fn(async () => 0),
  revisionCreate: vi.fn(),
  repositoryFindFirst: vi.fn(),
  fixFindMany: vi.fn(async () => [] as { fixPrNumber: number | null; status: string }[]),
  callerText: vi.fn(),
  openPrs: vi.fn(),
  branchHead: vi.fn(),
  mainHead: vi.fn(),
  rebuildCandidate: vi.fn(),
  dispatch: vi.fn(),
  prsByHead: vi.fn(),
  prForRebuild: vi.fn(),
  isAncestor: vi.fn(async () => true),
  registerVerification: vi.fn(),
  verifyJob: vi.fn(),
  reviewJob: vi.fn(),
  reservationUpdateMany: vi.fn(async () => ({ count: 1 })),
  reservationCount: vi.fn(async () => 1),
  reservationFindUnique: vi.fn(async () => null as unknown),
  reservationCreate: vi.fn(),
  reservationUpdate: vi.fn(),
  versionAtMerge: vi.fn(() => null as string | null),
  ensureSync: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const db = {
    releaseCandidate: {
      findUnique: mocks.candidateFindUnique,
      findFirst: mocks.candidateFindFirst,
      create: mocks.candidateCreate,
      updateMany: mocks.candidateUpdateMany,
      update: mocks.candidateUpdate,
    },
    releaseCandidateRevision: {
      findUnique: mocks.revisionFindUnique,
      findFirst: vi.fn(),
      findMany: mocks.revisionFindMany,
      updateMany: mocks.revisionUpdateMany,
      create: mocks.revisionCreate,
    },
    releaseFixSeries: { findMany: mocks.fixFindMany },
    releaseVersionReservation: {
      updateMany: mocks.reservationUpdateMany,
      count: mocks.reservationCount,
      findUnique: mocks.reservationFindUnique,
      create: mocks.reservationCreate,
      update: mocks.reservationUpdate,
    },
    releaseVerification: { findMany: vi.fn(async () => []) },
    repository: { findFirst: mocks.repositoryFindFirst },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/github/release-api", () => ({
  dispatchReleaseCandidateWorkflow: mocks.dispatch,
  fetchBranchHeadSha: mocks.branchHead,
  fetchCommitSummary: vi.fn(),
  fetchFileTextAtRef: vi.fn(async () => "x"),
  fetchMainHeadSha: mocks.mainHead,
  fetchOpenPullRequestsForBase: mocks.openPrs,
  fetchPullRequestForRebuild: mocks.prForRebuild,
  fetchPullRequestsByHead: mocks.prsByHead,
  fetchReleaseCallerText: mocks.callerText,
  fetchReleaseRebuildCandidate: mocks.rebuildCandidate,
  isAncestorCommit: mocks.isAncestor,
}));
vi.mock("@/lib/release-develop-sync-run", () => ({ ensureDevelopSync: mocks.ensureSync }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/actions-api", () => ({ closePullRequest: vi.fn() }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: vi.fn() }));
vi.mock("@/lib/release-finalize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/release-finalize")>()),
  parseFinalizeCallerSupport: () => ({ supported: true, versionFile: "package.json", versionQuery: "version", bumpCommand: false }),
  readVersionFromText: () => mocks.versionAtMerge(),
}));
vi.mock("@/lib/release-verification", () => ({
  registerReleaseVerification: mocks.registerVerification,
  listReleaseVerificationRecords: vi.fn(async () => []),
}));
vi.mock("@/lib/dispatch/release-verify-jobs", () => ({ requestReleaseVerifyJob: mocks.verifyJob }));
vi.mock("@/lib/dispatch/release-review-start", () => ({ requestReleaseReviewAfterIntegration: mocks.reviewJob }));

vi.mock("@/lib/release-fix-series-run", () => ({ closeFixSeriesForCancelledCandidate: (...a: unknown[]) => (mocks.closeSeries as (...x: unknown[]) => unknown)(...a) }));
import { cancelReleaseRc, createReleaseRc, loadRcImportOptions, reconcileRcCandidate, recordRcReport, requestRcImport } from "@/lib/release-rc-run";
import { RC_NOT_UPDATED_REASON } from "@/lib/release-rc";

const CALLER = "    inputs:\n      candidate_request:\n        type: string\n    with:\n      candidate-request: x\n";
const FROZEN = "f".repeat(40);
const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const ctx = { owner: "o", repo: "r", token: "t" };

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    repositoryFullName: "o/r",
    sequence: 3,
    phase: "review",
    frozenDevelopSha: FROZEN,
    frozenPrs: [{ number: 1, title: "a", mergeSha: "a".repeat(40) }],
    approvedExtraPrs: [],
    currentRevision: 1,
    activeKey: "o/r",
    migratedFromPrNumber: null,
    revisions: [
      {
        id: "r1",
        revision: 1,
        reason: "initial",
        status: "applied",
        expectedHeadSha: null,
        prNumber: 10,
        baseSha: "b".repeat(40),
        headSha: HEAD1,
        importedPrs: [],
        createdAt: new Date(),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callerText.mockResolvedValue(CALLER);
  mocks.candidateFindUnique.mockResolvedValue(null);
  mocks.revisionFindUnique.mockResolvedValue(null);
  mocks.candidateFindFirst.mockResolvedValue(null);
  mocks.openPrs.mockResolvedValue([]);
  // 候補ブランチ（release-rc/<番号>）のrefは既定で読めない扱いにし、PRのheadへ戻す。developなどはFROZEN
  mocks.branchHead.mockImplementation(async (_o: string, _r: string, branch: string) => (branch.startsWith("release-rc/") ? null : FROZEN));
  mocks.mainHead.mockResolvedValue("m".repeat(40));
  mocks.rebuildCandidate.mockResolvedValue({ pullRequests: [{ number: 1, title: "a", mergeSha: "a".repeat(40) }] });
  mocks.candidateCreate.mockResolvedValue({ id: "c1", sequence: 1 });
  mocks.repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
  mocks.isAncestor.mockResolvedValue(true);
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.fixFindMany.mockResolvedValue([]);
});

describe("createReleaseRc", () => {
  const syncStatus = (state: "synced" | "unsynced" | "unknown") => ({
    state,
    detail: state === "synced" ? "ancestor" : state === "unsynced" ? "awaiting_merge" : "unreadable",
    label: "l",
    reason: state === "unknown" ? "developの先端を取得できませんでした" : "mainにだけある変更が2ファイルあります",
    nextAction: state === "synced" ? null : "同期PR #50 をマージしてください",
    canCreate: false,
    mainSha: null,
    developSha: null,
    mainOnlyFiles: [],
    pullRequest: null,
  });
  beforeEach(() => {
    mocks.ensureSync.mockResolvedValue(syncStatus("synced"));
  });

  it("前回の公開がdevelopへ戻っていない間は作らない（同期PRを用意したうえで断る。#4641）", async () => {
    mocks.ensureSync.mockResolvedValue(syncStatus("unsynced"));
    const result = await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" });
    expect(result).toMatchObject({ ok: false, error: "develop_not_synced" });
    expect((result as { message: string }).message).toContain("同期PR #50");
    expect(mocks.ensureSync).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r" }));
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("同期を判定できないときも同期済みとはみなさず作らない（#4641）", async () => {
    mocks.ensureSync.mockResolvedValue(syncStatus("unknown"));
    const result = await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" });
    expect(result).toMatchObject({ ok: false, error: "develop_sync_unknown" });
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
  });

  it("developの先端を固定し、正式版の指定なしでworkflowを起動する", async () => {
    const result = await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" });
    expect(result).toEqual({ ok: true, candidateId: "c1", revision: 1, existing: false });
    expect(mocks.rebuildCandidate).toHaveBeenCalledWith("o", "r", "m".repeat(40), "t", FROZEN);
    const request = JSON.parse(mocks.dispatch.mock.calls[0][3]);
    expect(request).toMatchObject({ mode: "create", revision: 1, baseHeadSha: FROZEN, prs: [] });
    expect(mocks.candidateCreate.mock.calls[0][0].data).toMatchObject({ activeKey: "o/r", phase: "creating", frozenDevelopSha: FROZEN });
  });

  it("同じ要求キーの再送は既存を返し、二重に作らない", async () => {
    mocks.candidateFindUnique.mockImplementation(async ({ where }: { where: { requestKey?: string } }) =>
      where.requestKey ? { id: "c1" } : null,
    );
    const result = await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" });
    expect(result).toMatchObject({ ok: true, existing: true });
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("旧方式の候補が開いている間は作らない（閉じない・バンプを戻さない）", async () => {
    mocks.openPrs.mockResolvedValue([{ number: 9, head: { ref: "release-main/v8.56.0", sha: HEAD1 } }]);
    expect(await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" })).toEqual({ ok: false, error: "legacy_open" });
    expect(mocks.candidateCreate).not.toHaveBeenCalled();
  });

  it("callerが未対応なら理由付きで断る", async () => {
    mocks.callerText.mockResolvedValue("      rebuild_selection:\n");
    expect(await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" })).toEqual({ ok: false, error: "caller_unsupported" });
  });

  it("起動に失敗したら失敗を記録し、候補を解放する（記録は残す）", async () => {
    mocks.dispatch.mockRejectedValue(new Error("422"));
    mocks.candidateFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id ? candidateRow({ phase: "creating", currentRevision: 0, revisions: [{ id: "r1", revision: 1, status: "requested" }] }) : null,
    );
    expect(await createReleaseRc({ ...ctx, userId: "u1", requestKey: "key-000001" })).toEqual({ ok: false, error: "dispatch_failed" });
    expect(mocks.revisionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", status: "requested" }, data: expect.objectContaining({ status: "failed", pendingKey: null }) }),
    );
    expect(mocks.candidateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phase: "cancelled", activeKey: null }) }),
    );
  });
});

describe("requestRcImport", () => {
  const base = { ...ctx, userId: "u1", candidateId: "c1", approveExtra: [] as number[], requestKey: "key-000002", source: "manual" as const };

  beforeEach(() => {
    mocks.candidateFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? candidateRow() : null));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", head: { sha: HEAD1, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } }]);
    mocks.isAncestor.mockResolvedValue(false);
    mocks.prForRebuild.mockImplementation(async (_o: string, _r: string, n: number) => ({
      number: n,
      title: `PR${n}`,
      merged_at: "2026-10-12T00:00:00Z",
      merge_commit_sha: `${n}`.padEnd(40, "0"),
      base: { ref: "develop" },
      head: { ref: `issue-${n}` },
    }));
  });

  it("画面で見ていたheadと違えば受け付けない", async () => {
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD2, selected: [{ number: 21 }] });
    expect(result).toEqual({ ok: false, error: "candidate_changed" });
    expect(mocks.revisionCreate).not.toHaveBeenCalled();
  });

  it("関連修正でないPRは承認なしに取り込まない", async () => {
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD1, selected: [{ number: 21 }] });
    expect(result).toEqual({ ok: false, error: "approval_required", unapproved: [21] });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("関連修正は取り込み、直前のheadから積むよう依頼する", async () => {
    mocks.fixFindMany.mockResolvedValue([{ fixPrNumber: 21, status: "fix_merged" }]);
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD1, selected: [{ number: 21 }] });
    expect(result).toEqual({ ok: true, candidateId: "c1", revision: 2, existing: false });
    expect(mocks.revisionCreate.mock.calls[0][0].data).toMatchObject({ revision: 2, expectedHeadSha: HEAD1, pendingKey: "c1", status: "requested" });
    expect(JSON.parse(mocks.dispatch.mock.calls[0][3])).toMatchObject({ mode: "import", baseHeadSha: HEAD1, prs: [{ number: 21 }] });
  });

  it("更新中は2本目を受け付けない", async () => {
    mocks.candidateFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id
        ? candidateRow({ revisions: [...candidateRow().revisions, { id: "r2", revision: 2, status: "requested", createdAt: new Date() }] })
        : null,
    );
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD1, selected: [{ number: 21 }] });
    expect(result).toEqual({ ok: false, error: "revision_in_progress" });
  });

  it("失敗した更新と同じ要求キーの再送は成功として返さない（#4986）", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ candidateId: "c1", revision: 2, status: "failed" });
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD1, selected: [{ number: 21 }] });
    expect(result).toMatchObject({ ok: false, error: "dispatch_failed" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("起動済みの更新と同じ要求キーの再送は既存を返す", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ candidateId: "c1", revision: 2, status: "requested" });
    const result = await requestRcImport({ ...base, expectedHeadSha: HEAD1, selected: [{ number: 21 }] });
    expect(result).toEqual({ ok: true, candidateId: "c1", revision: 2, existing: true });
  });
});

describe("loadRcImportOptions（#4986）", () => {
  const RC_PR = { number: 10, state: "open", head: { sha: HEAD1, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } };
  const pr = (n: number, over: Record<string, unknown> = {}) => ({
    number: n, title: `PR${n}`, merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: `${n}`.padEnd(40, "0"),
    base: { ref: "develop" }, head: { ref: `issue-${n}` }, ...over,
  });

  beforeEach(() => {
    mocks.candidateFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? candidateRow() : null));
    mocks.prsByHead.mockResolvedValue([RC_PR]);
    mocks.isAncestor.mockResolvedValue(false);
    mocks.rebuildCandidate.mockResolvedValue({
      pullRequests: [
        { number: 684, title: "証跡補充", issueNumber: null, mergeSha: "e".repeat(40) },
        { number: 686, title: "安全修正", issueNumber: 12, mergeSha: "f".repeat(40) },
      ],
    });
  });

  it("候補headの後のPRを返し、修正系列のPRは承認不要・範囲外は承認要と示す", async () => {
    mocks.fixFindMany.mockResolvedValue([{ fixPrNumber: 686, status: "fix_merged" }]);
    const result = await loadRcImportOptions(ctx, "c1");
    expect(result).toMatchObject({ candidateId: "c1", headSha: HEAD1, blocked: null });
    expect(mocks.rebuildCandidate.mock.calls[0][2]).toBe(HEAD1);
    expect(result?.options.map((o) => [o.number, o.relatedFix, o.approvalRequired])).toEqual([
      [684, false, true],
      [686, true, false],
    ]);
  });

  it("未マージの修正系列PRは理由付きで選べない", async () => {
    mocks.fixFindMany.mockResolvedValue([{ fixPrNumber: 700, status: "fix_pending" }]);
    mocks.prForRebuild.mockResolvedValue(pr(700, { merged_at: null, merge_commit_sha: null }));
    const result = await loadRcImportOptions(ctx, "c1");
    expect(result?.options.find((o) => o.number === 700)).toMatchObject({ problem: "not_merged", approvalRequired: false });
  });

  it("別リポジトリの候補・候補PRが開いていない場合は返さない", async () => {
    mocks.candidateFindUnique.mockImplementation(async () => candidateRow({ repositoryFullName: "x/y" }));
    expect(await loadRcImportOptions(ctx, "c1")).toBeNull();
    mocks.candidateFindUnique.mockImplementation(async () => candidateRow());
    mocks.prsByHead.mockResolvedValue([]);
    expect(await loadRcImportOptions(ctx, "c1")).toBeNull();
  });

  it("候補ブランチの先端が記録と違えば取り込めないと示す", async () => {
    mocks.branchHead.mockImplementation(async (_o: string, _r: string, branch: string) => (branch.startsWith("release-rc/") ? HEAD2 : FROZEN));
    const result = await loadRcImportOptions(ctx, "c1");
    expect(result?.headSha).toBe(HEAD2);
    expect(result?.blocked).toContain("記録と一致しません");
  });

  it("取り込みの更新が進行中なら取り込めないと示す", async () => {
    mocks.candidateFindUnique.mockImplementation(async () =>
      candidateRow({ revisions: [...candidateRow().revisions, { id: "r2", revision: 2, status: "requested", createdAt: new Date() }] }),
    );
    expect((await loadRcImportOptions(ctx, "c1"))?.blocked).toContain("進行中");
  });
});

describe("recordRcReport", () => {
  it("適用済みの要求への再送・遅延報告は何も変えない", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ id: "r2", candidateId: "c1", status: "applied" });
    mocks.candidateFindUnique.mockResolvedValue(candidateRow());
    const result = await recordRcReport({ repositoryFullName: "o/r", requestKey: "key-000002", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "ignored" });
    expect(mocks.revisionUpdateMany).not.toHaveBeenCalled();
  });

  it("更新の失敗は記録するが、現在のrevisionと候補は残す", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ id: "r2", candidateId: "c1", status: "requested" });
    mocks.candidateFindUnique.mockResolvedValue(candidateRow());
    const result = await recordRcReport({ repositoryFullName: "o/r", requestKey: "key-000002", outcome: "failed", runId: 5, reason: "競合" });
    expect(result).toEqual({ ok: true, outcome: "failed" });
    expect(mocks.revisionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed", failureReason: "競合" }) }),
    );
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("適用の報告は候補ブランチを取り直して確かめ、新しいSHAで検証を依頼する", async () => {
    const row = candidateRow({
      revisions: [
        ...candidateRow().revisions,
        { id: "r2", revision: 2, reason: "fix_import", status: "requested", expectedHeadSha: HEAD1, importedPrs: [], createdAt: new Date() },
      ],
    });
    mocks.revisionFindUnique.mockResolvedValue({ id: "r2", candidateId: "c1", status: "requested" });
    mocks.candidateFindUnique.mockResolvedValue(row);
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", head: { sha: HEAD2, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } }]);
    const result = await recordRcReport({ repositoryFullName: "o/r", requestKey: "key-000002", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "applied" });
    expect(mocks.isAncestor).toHaveBeenCalledWith("o", "r", HEAD1, HEAD2, "t");
    expect(mocks.registerVerification).toHaveBeenCalledWith({ repoFullName: "o/r", prNumber: 10, baseSha: "b".repeat(40), headSha: HEAD2 });
    expect(mocks.candidateUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", currentRevision: { lt: 2 } }, data: { currentRevision: 2 } });
  });

  const pendingImport = () =>
    candidateRow({
      revisions: [
        ...candidateRow().revisions,
        { id: "r2", revision: 2, reason: "fix_import", status: "requested", expectedHeadSha: HEAD1, importedPrs: [], createdAt: new Date() },
      ],
    });

  it("PRのheadの反映が遅れていても、候補ブランチのrefが進んでいれば適用する（#4895）", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ id: "r2", candidateId: "c1", status: "requested" });
    mocks.candidateFindUnique.mockResolvedValue(pendingImport());
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", head: { sha: HEAD1, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } }]);
    mocks.branchHead.mockResolvedValue(HEAD2);
    const result = await recordRcReport({ repositoryFullName: "o/r", requestKey: "key-000002", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "applied" });
    expect(mocks.branchHead).toHaveBeenCalledWith("o", "r", "release-rc/3", "t");
    expect(mocks.revisionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r2", status: "requested" }, data: expect.objectContaining({ status: "applied", headSha: HEAD2 }) }),
    );
  });

  it("適用の報告が届いても候補ブランチがまだ直前のheadなら、失敗にせず待つ（#4895）", async () => {
    mocks.revisionFindUnique.mockResolvedValue({ id: "r2", candidateId: "c1", status: "requested" });
    mocks.candidateFindUnique.mockResolvedValue(pendingImport());
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", head: { sha: HEAD1, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } }]);
    const result = await recordRcReport({ repositoryFullName: "o/r", requestKey: "key-000002", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "waiting" });
    expect(mocks.revisionUpdateMany).not.toHaveBeenCalled();
  });
});

describe("reconcileRcCandidate（照合の時差で失敗扱いにした版の取り込み直し。#4895）", () => {
  const laggedRow = (overrides: Record<string, unknown> = {}) =>
    candidateRow({
      revisions: [
        ...candidateRow().revisions,
        {
          id: "r2",
          revision: 2,
          reason: "fix_import",
          status: "failed",
          failureReason: RC_NOT_UPDATED_REASON,
          runUrl: "https://github.com/o/r/actions/runs/5",
          expectedHeadSha: HEAD1,
          importedPrs: [],
          createdAt: new Date(),
          ...overrides,
        },
      ],
    });

  beforeEach(() => {
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", head: { sha: HEAD2, ref: "release-rc/3" }, base: { sha: "b".repeat(40) } }]);
  });

  it("候補ブランチが直前のheadから早送りで進んでいれば、その先端で適用して検証を依頼する", async () => {
    mocks.candidateFindUnique.mockResolvedValue(laggedRow());
    await reconcileRcCandidate("o/r", "c1");
    expect(mocks.isAncestor).toHaveBeenCalledWith("o", "r", HEAD1, HEAD2, "t");
    expect(mocks.revisionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r2", status: "failed", failureReason: RC_NOT_UPDATED_REASON },
        data: expect.objectContaining({ status: "applied", failureReason: null, headSha: HEAD2, prNumber: 10 }),
      }),
    );
    expect(mocks.registerVerification).toHaveBeenCalledWith({ repoFullName: "o/r", prNumber: 10, baseSha: "b".repeat(40), headSha: HEAD2 });
  });

  it("workflowが失敗を報告した版は取り込み直さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(laggedRow({ failureReason: "競合" }));
    await reconcileRcCandidate("o/r", "c1");
    expect(mocks.revisionUpdateMany).not.toHaveBeenCalled();
  });

  it("早送りでない（書き換え・巻き戻し）なら取り込み直さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(laggedRow());
    mocks.isAncestor.mockResolvedValue(false);
    await reconcileRcCandidate("o/r", "c1");
    expect(mocks.revisionUpdateMany).not.toHaveBeenCalled();
  });
});

describe("cancelReleaseRc", () => {
  const cancel = () => cancelReleaseRc({ ...ctx, userId: "u1", candidateId: "c1", reason: null });

  it("候補PRがmainへマージ済みなら、予約した版をマージのSHAで消費済みにしてから取り消す（版の再利用・develop同期の検出漏れを防ぐ）", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    expect(await cancel()).toMatchObject({ ok: true });
    expect(mocks.reservationUpdateMany).toHaveBeenCalledWith({
      where: { candidateId: "c1", status: "reserved" },
      data: expect.objectContaining({ status: "consumed", consumedMergeSha: "9".repeat(40) }),
    });
  });

  it("取り消した候補のPR（revisionのPR）に紐づく修正系列を畳む（#4800）", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "review" }));
    mocks.prsByHead.mockResolvedValue([]);
    mocks.revisionFindMany.mockResolvedValueOnce([{ prNumber: 10 }, { prNumber: null }, { prNumber: 12 }]);
    expect(await cancel()).toMatchObject({ ok: true });
    expect(mocks.closeSeries).toHaveBeenCalledWith(expect.objectContaining({ repositoryFullName: "o/r", prNumbers: expect.arrayContaining([10, 12]) }));
  });

  it("自動バンプで予約が無いままマージ済みなら、mainの版を確定して消費済みの予約を作ってから取り消す", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce("1.2.3");
    expect(await cancel()).toMatchObject({ ok: true });
    expect(mocks.reservationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: "1.2.3", candidateId: "c1", status: "consumed", consumedMergeSha: "9".repeat(40) }),
    });
  });

  it("予約が無く、マージ後の版を確定できなければ取り消さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce(null);
    expect(await cancel()).toMatchObject({ ok: false, error: "not_cancellable" });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reservationCreate).not.toHaveBeenCalled();
  });

  it("確定した版が台帳に既にあるときは（今回のマージで上がった版と限らないため）取り消さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce("1.2.3");
    mocks.reservationFindUnique.mockResolvedValueOnce({ id: "r0", status: "consumed", candidateId: "old", consumedMergeSha: "1".repeat(40) });
    expect(await cancel()).toMatchObject({ ok: false, error: "not_cancellable" });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("版の台帳への書き込みが競合したときは取消が戻り、candidate_changedになる", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce("1.2.3");
    mocks.reservationCreate.mockRejectedValueOnce({ code: "P2002" });
    expect(await cancel()).toEqual({ ok: false, error: "candidate_changed" });
  });

  it("マージ済みでもマージのSHAが分からなければ取り消さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "awaiting_approval" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: null }]);
    expect(await cancel()).toMatchObject({ ok: false, error: "not_cancellable" });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("マージの有無を確かめられないときも取り消さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "awaiting_approval" }));
    mocks.prsByHead.mockRejectedValue(new Error("boom"));
    expect(await cancel()).toMatchObject({ ok: false, error: "not_cancellable" });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("未マージなら従来どおり取り消せる", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "open", merged_at: null }]);
    expect(await cancel()).toMatchObject({ ok: true, existing: false });
    expect(mocks.reservationUpdateMany).not.toHaveBeenCalled();
  });

  it("レビュー中のままPRがマージ済みの候補（管理記録だけが残った状態。#4628）も、版を消費済みにしてから取り消す", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "review" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce("8.59.0");
    expect(await cancel()).toMatchObject({ ok: true });
    expect(mocks.reservationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: "8.59.0", status: "consumed", consumedMergeSha: "9".repeat(40) }),
    });
  });

  it("レビュー中のマージ済み候補で、マージ時点の版が台帳に既にあれば理由つきで取り消さない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "review" }));
    mocks.prsByHead.mockResolvedValue([{ number: 10, state: "closed", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "9".repeat(40) }]);
    mocks.reservationCount.mockResolvedValueOnce(0);
    mocks.versionAtMerge.mockReturnValueOnce("8.59.0");
    mocks.reservationFindUnique.mockResolvedValueOnce({ id: "r0", status: "consumed", candidateId: "old", consumedMergeSha: "1".repeat(40) });
    expect(await cancel()).toMatchObject({ ok: false, error: "not_cancellable", message: expect.stringContaining("8.59.0") });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });

  it("画面で見ていた段階と違うときは、古い表示からの取消を受け付けない", async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidateRow({ phase: "preparing" }));
    expect(await cancelReleaseRc({ ...ctx, userId: "u1", candidateId: "c1", reason: null, expectedPhase: "review" })).toEqual({
      ok: false,
      error: "candidate_changed",
    });
    expect(mocks.candidateUpdateMany).not.toHaveBeenCalled();
  });
});
