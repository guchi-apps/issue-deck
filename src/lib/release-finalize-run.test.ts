import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finFindUnique: vi.fn(),
  finFindFirst: vi.fn(),
  finFindMany: vi.fn(async () => [] as unknown[]),
  finCreate: vi.fn(),
  finUpdateMany: vi.fn<(...a: unknown[]) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  resFindMany: vi.fn(async () => [] as unknown[]),
  resFindUnique: vi.fn(async () => null),
  resCreate: vi.fn(),
  resUpdateMany: vi.fn(async () => ({ count: 1 })),
  candUpdateMany: vi.fn(async () => ({ count: 1 })),
  revCreate: vi.fn(),
  repositoryFindFirst: vi.fn(),
  loadRcOverview: vi.fn(),
  loadCandidateRow: vi.fn(),
  observePr: vi.fn(),
  callerText: vi.fn(),
  mainHead: vi.fn(),
  fileText: vi.fn(),
  tagRefs: vi.fn(async () => [] as { ref: string; sha: string }[]),
  dispatch: vi.fn(),
  compareFiles: vi.fn(),
  isAncestor: vi.fn(async () => true),
  fetchPr: vi.fn(),
  records: vi.fn(async () => [] as unknown[]),
  register: vi.fn(),
  verifyJob: vi.fn(),
  reviewJob: vi.fn(),
  macRows: vi.fn(async () => [] as unknown[]),
  developHead: vi.fn(),
  openPrs: vi.fn(),
  createPr: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const db = {
    releaseCandidateFinalization: {
      findUnique: mocks.finFindUnique,
      findFirst: mocks.finFindFirst,
      findMany: mocks.finFindMany,
      create: mocks.finCreate,
      updateMany: mocks.finUpdateMany,
    },
    releaseVersionReservation: { findMany: mocks.resFindMany, findUnique: mocks.resFindUnique, create: mocks.resCreate, updateMany: mocks.resUpdateMany },
    releaseCandidate: { updateMany: mocks.candUpdateMany },
    releaseCandidateRevision: { create: mocks.revCreate, findFirst: vi.fn() },
    repository: { findFirst: mocks.repositoryFindFirst },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});
vi.mock("@/lib/release-rc-run", () => ({
  loadRcOverview: mocks.loadRcOverview,
  loadCandidateRow: mocks.loadCandidateRow,
  observeCandidatePullRequest: mocks.observePr,
}));
vi.mock("@/lib/github/release-api", () => ({
  createPullRequest: mocks.createPr,
  fetchBranchHeadSha: mocks.developHead,
  fetchOpenPullRequestsForBase: mocks.openPrs,
  dispatchReleaseFinalizeWorkflow: mocks.dispatch,
  fetchCompareChangedFiles: mocks.compareFiles,
  fetchFileTextAtRef: mocks.fileText,
  fetchMainHeadSha: mocks.mainHead,
  fetchPullRequestCiState: vi.fn(async () => ({ ciState: "pending" })),
  fetchReleaseCallerText: mocks.callerText,
  fetchTagRefs: mocks.tagRefs,
  isAncestorCommit: mocks.isAncestor,
}));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequest: mocks.fetchPr }));
vi.mock("@/lib/github/actions-api", () => ({ markPullRequestReadyForReview: vi.fn() }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/deploy-recovery-series-run", () => ({ fetchDeployRunsForSha: vi.fn(async () => []), hasVersionVerification: vi.fn(async () => false) }));
vi.mock("@/lib/release-verification", () => ({
  listReleaseVerificationRecords: mocks.records,
  registerReleaseVerification: mocks.register,
}));
vi.mock("@/lib/release-mac-verification", () => ({ listReleaseMacRows: mocks.macRows }));
vi.mock("@/lib/dispatch/release-verify-jobs", () => ({ requestReleaseVerifyJob: mocks.verifyJob }));
vi.mock("@/lib/dispatch/release-review-jobs", () => ({ requestReleaseReviewJob: mocks.reviewJob }));

import { ensureDevelopSync, findUnsyncedPublish, recordFinalizeReport, requestRcFinalize } from "@/lib/release-finalize-run";

const CALLER = "    inputs:\n      finalize_request:\n    with:\n      finalize-request: x\n";
const BASE = "b".repeat(40);
const PRE = "a".repeat(40);
const POST = "c".repeat(40);
const ctx = { owner: "o", repo: "r", token: "t" };

const contract = { candidateId: "c1", sequence: 3, revision: 2, prNumber: 10, baseSha: BASE, headSha: PRE, frozenDevelopSha: "f".repeat(40), includedPrs: [1] };

function overview(over: Record<string, unknown> = {}) {
  return { candidate: { id: "c1", sequence: 3, phase: "review", finalizeContract: contract, ...over } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callerText.mockResolvedValue(CALLER);
  mocks.finFindUnique.mockResolvedValue(null);
  mocks.finFindFirst.mockResolvedValue(null);
  mocks.finFindMany.mockResolvedValue([]);
  mocks.finCreate.mockResolvedValue({ id: "f1" });
  mocks.resFindMany.mockResolvedValue([]);
  mocks.resFindUnique.mockResolvedValue(null);
  mocks.loadRcOverview.mockResolvedValue(overview());
  mocks.observePr.mockResolvedValue({ number: 10, state: "open", head: { sha: PRE, ref: "release-rc/3" }, base: { sha: BASE } });
  mocks.mainHead.mockResolvedValue(BASE);
  mocks.fileText.mockResolvedValue('{"version":"2.13.4"}');
  mocks.tagRefs.mockResolvedValue([]);
});

describe("requestRcFinalize", () => {
  const input = { ...ctx, userId: "u1", candidateId: "c1", expectedHeadSha: PRE, bumpKind: "minor" as const, requestKey: "reqkey0001" };

  it("合格した候補だけ、版を予約してから段階を進め、workflowへ固定した前提を渡す", async () => {
    const result = await requestRcFinalize(input);
    expect(result).toEqual({ ok: true, finalizationId: "f1", existing: false });
    expect(mocks.resCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ version: "2.14.0", status: "reserved", candidateId: "c1" }) });
    expect(mocks.candUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", phase: "review" }, data: { phase: "preparing" } });
    const sent = JSON.parse(mocks.dispatch.mock.calls[0][3] as string);
    expect(sent).toMatchObject({ baseHeadSha: PRE, bumpKind: "minor", version: "2.14.0", requestKey: "reqkey0001", sequence: 3 });
  });

  it("自動判定の再試行でも、未消費の自予約があればその版・上げ幅へ固定する", async () => {
    mocks.resFindMany.mockResolvedValue([{ id: "r1", version: "2.14.0", candidateId: "c1", status: "reserved" }]);
    await requestRcFinalize({ ...input, bumpKind: null, requestKey: "reqkey0002" });
    const sent = JSON.parse(mocks.dispatch.mock.calls[0][3] as string);
    expect(sent).toMatchObject({ bumpKind: "minor", version: "2.14.0" });
    expect(mocks.resCreate).not.toHaveBeenCalled();
  });

  it("自予約がmainの前進で無効なら、従来どおりautoで渡す", async () => {
    mocks.resFindMany.mockResolvedValue([{ id: "r1", version: "2.12.0", candidateId: "c1", status: "reserved" }]);
    await requestRcFinalize({ ...input, bumpKind: null, requestKey: "reqkey0003" });
    const sent = JSON.parse(mocks.dispatch.mock.calls[0][3] as string);
    expect(sent).toMatchObject({ bumpKind: "auto", version: "2.12.0" });
  });

  it("合格していない候補（契約が無い）ではバンプしない", async () => {
    mocks.loadRcOverview.mockResolvedValue(overview({ finalizeContract: null }));
    expect(await requestRcFinalize(input)).toEqual({ ok: false, error: "not_ready" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.resCreate).not.toHaveBeenCalled();
  });

  it("修正・検証中（段階がreview以外）やmainの前進・候補の更新では始めない", async () => {
    mocks.loadRcOverview.mockResolvedValue(overview({ phase: "preparing" }));
    expect(await requestRcFinalize(input)).toEqual({ ok: false, error: "wrong_phase" });
    mocks.loadRcOverview.mockResolvedValue(overview());
    mocks.mainHead.mockResolvedValue("d".repeat(40));
    expect(await requestRcFinalize(input)).toEqual({ ok: false, error: "main_advanced" });
    mocks.mainHead.mockResolvedValue(BASE);
    expect(await requestRcFinalize({ ...input, expectedHeadSha: POST })).toEqual({ ok: false, error: "candidate_changed" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("同じ要求キーの再送は何も作らず既存を返す（二重実行しない）", async () => {
    mocks.finFindUnique.mockResolvedValue({ id: "f0" });
    expect(await requestRcFinalize(input)).toEqual({ ok: true, finalizationId: "f0", existing: true });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.finCreate).not.toHaveBeenCalled();
  });

  it("進行中の公開準備があれば始めない", async () => {
    mocks.finFindFirst.mockResolvedValue({ id: "f0", status: "requested", createdAt: new Date() });
    expect(await requestRcFinalize(input)).toEqual({ ok: false, error: "in_progress" });
  });

  it("他の候補が予約している版・タグ済みの版は取らない（タグ済みは欠番にして次へ）", async () => {
    mocks.resFindMany.mockResolvedValue([{ id: "x", version: "2.14.0", candidateId: "other", status: "reserved" }]);
    expect(await requestRcFinalize(input)).toMatchObject({ ok: false, error: "version_conflict" });
    mocks.resFindMany.mockResolvedValue([]);
    mocks.tagRefs.mockResolvedValue([{ ref: "refs/tags/v2.14.0", sha: "x" }]);
    await requestRcFinalize({ ...input, requestKey: "reqkey0002" });
    expect(mocks.resCreate).toHaveBeenLastCalledWith({ data: expect.objectContaining({ version: "2.14.1" }) });
  });

  it("workflowを起動できなければ失敗として残し、候補を修正工程へ戻して予約は手放さない", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("422"));
    mocks.finFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "f1", candidateId: "c1" });
    expect(await requestRcFinalize(input)).toEqual({ ok: false, error: "dispatch_failed" });
    expect(mocks.finUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", pendingKey: null }) }));
    expect(mocks.candUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", phase: "preparing" }, data: { phase: "review" } });
    expect(mocks.resUpdateMany).not.toHaveBeenCalled();
  });
});

describe("recordFinalizeReport", () => {
  const finalization = {
    id: "f1",
    candidateId: "c1",
    repositoryFullName: "o/r",
    requestKey: "reqkey0001",
    status: "requested",
    revision: 2,
    prNumber: 10,
    preBaseSha: BASE,
    preHeadSha: PRE,
    reservedVersion: "2.14.0",
    bumpKind: "minor",
    bumpKindSource: "manual",
    createdAt: new Date(),
  };
  const candidateRow = { id: "c1", sequence: 3, phase: "preparing", currentRevision: 2, revisions: [{ revision: 2 }] };

  beforeEach(() => {
    mocks.repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
    mocks.finFindUnique.mockResolvedValue(finalization);
    mocks.loadCandidateRow.mockResolvedValue(candidateRow);
    mocks.fetchPr.mockResolvedValue({ number: 10, state: "open", draft: true, merged: false, head: { sha: POST }, base: { sha: BASE } });
    mocks.observePr.mockResolvedValue({ number: 10, state: "open", head: { sha: POST }, base: { sha: BASE } });
    mocks.compareFiles.mockResolvedValue(["package.json", ".github/release-notes.md"]);
    mocks.fileText.mockImplementation(async (_o: string, _r: string, _p: string, ref: string) => (ref === POST ? '{"version":"2.14.0"}' : '{"version":"2.13.4"}'));
    mocks.records.mockResolvedValue([
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: PRE },
      { kind: "integration", state: "passed", baseSha: BASE, headSha: PRE },
    ]);
  });

  it("バンプ後のheadをrevisionとして記録し、引継ぎの証跡を残し、再検証が要る種別だけを依頼する", async () => {
    // iOS（Mac）検証が必要なリポジトリ: 統合検証はバンプ後のheadで再実行する
    mocks.macRows.mockResolvedValue([{ state: "passed" }]);
    const result = await recordFinalizeReport({ repositoryFullName: "o/r", requestKey: "reqkey0001", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "applied" });
    const applied = mocks.finUpdateMany.mock.calls.find((c) => (c[0] as { data: { status?: string } }).data.status === "applied")![0] as { data: Record<string, unknown> };
    expect(applied.data).toMatchObject({ finalHeadSha: POST, finalBaseSha: BASE, reservedVersion: "2.14.0" });
    const evidence = applied.data.handoffEvidence as { kind: string; action: string; fromHeadSha: string; toHeadSha: string }[];
    expect(evidence.find((e) => e.kind === "ai_review")).toMatchObject({ action: "inherit", fromHeadSha: PRE, toHeadSha: POST });
    expect(evidence.find((e) => e.kind === "integration")).toMatchObject({ action: "rerun", fromHeadSha: PRE, toHeadSha: POST });
    // バンプ後のheadを`finalize_bump`のrevisionとして記録する（旧SHAの結果は書き換えない）
    expect(mocks.revCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ reason: "finalize_bump", headSha: POST, expectedHeadSha: PRE, revision: 3, status: "applied" }) });
    // 引き継いだ全体レビューは再実行せず、統合検証だけをバンプ後のheadで依頼する
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ headSha: POST }), ["integration"]);
    expect(mocks.verifyJob).toHaveBeenCalledTimes(1);
    expect(mocks.reviewJob).not.toHaveBeenCalled();
  });

  it("版ファイルが予約した版になっていなければ適用せず、失敗として修正工程へ戻す", async () => {
    mocks.fileText.mockResolvedValue('{"version":"2.13.4"}');
    const result = await recordFinalizeReport({ repositoryFullName: "o/r", requestKey: "reqkey0001", outcome: "applied", runId: 5, reason: null });
    expect(result).toEqual({ ok: true, outcome: "failed" });
    expect(mocks.revCreate).not.toHaveBeenCalled();
    expect(mocks.candUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", phase: "preparing" }, data: { phase: "review" } });
  });

  it("適用済み・失敗済みの要求への再送は何も変えない", async () => {
    mocks.finFindUnique.mockResolvedValue({ ...finalization, status: "applied" });
    expect(await recordFinalizeReport({ repositoryFullName: "o/r", requestKey: "reqkey0001", outcome: "applied", runId: null, reason: null })).toEqual({ ok: true, outcome: "ignored" });
    expect(mocks.revCreate).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("workflowの失敗報告は、候補を修正工程へ戻し、予約した版を保つ", async () => {
    const result = await recordFinalizeReport({ repositoryFullName: "o/r", requestKey: "reqkey0001", outcome: "failed", runId: 7, reason: "ビルドに失敗" });
    expect(result).toEqual({ ok: true, outcome: "failed" });
    expect(mocks.candUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", phase: "preparing" }, data: { phase: "review" } });
    expect(mocks.resUpdateMany).not.toHaveBeenCalled();
  });

  it("未知のリポジトリ・要求は記録しない", async () => {
    mocks.repositoryFindFirst.mockResolvedValue(null);
    expect(await recordFinalizeReport({ repositoryFullName: "o/x", requestKey: "reqkey0001", outcome: "applied", runId: null, reason: null })).toEqual({ ok: false, reason: "unknown_repository" });
    mocks.repositoryFindFirst.mockResolvedValue({ ownerLogin: "o", name: "r", installation: { installationId: 1 } });
    mocks.finFindUnique.mockResolvedValue(null);
    expect(await recordFinalizeReport({ repositoryFullName: "o/r", requestKey: "nokey00001", outcome: "applied", runId: null, reason: null })).toEqual({ ok: false, reason: "unknown_request" });
  });
});

describe("公開後のdevelop整合", () => {
  const MERGE = "9".repeat(40);
  const DEV = "8".repeat(40);

  beforeEach(() => {
    mocks.developHead.mockResolvedValue(DEV);
    mocks.openPrs.mockResolvedValue([]);
    mocks.createPr.mockResolvedValue({ number: 99, html_url: "u" });
  });

  it("公開した版がdevelopに無ければ、mainをdevelopへ同期するPRを作る", async () => {
    mocks.isAncestor.mockResolvedValueOnce(false);
    expect(await ensureDevelopSync(ctx, { version: "2.14.0", mergeSha: MERGE })).toBe("created");
    expect(mocks.createPr).toHaveBeenCalledWith("o", "r", "t", expect.objectContaining({ head: "main", base: "develop", title: "v2.14.0の公開をdevelopへ同期する" }));
  });

  it("反映済み・同期PRが開いている間は作らない（二重に作らない）", async () => {
    mocks.isAncestor.mockResolvedValueOnce(true);
    expect(await ensureDevelopSync(ctx, { version: "2.14.0", mergeSha: MERGE })).toBe("synced");
    mocks.isAncestor.mockResolvedValueOnce(false);
    mocks.openPrs.mockResolvedValue([{ head: { ref: "main" } }]);
    expect(await ensureDevelopSync(ctx, { version: "2.14.0", mergeSha: MERGE })).toBe("pending");
    expect(mocks.createPr).not.toHaveBeenCalled();
  });

  it("作成に失敗しても例外にせず失敗として返す（本番反映の追跡を止めない）", async () => {
    mocks.isAncestor.mockResolvedValueOnce(false);
    mocks.createPr.mockRejectedValueOnce(new Error("422"));
    expect(await ensureDevelopSync(ctx, { version: "2.14.0", mergeSha: MERGE })).toBe("failed");
  });

  it("公開した版がdevelopへ反映されるまで、次の候補の作成を止める", async () => {
    mocks.resFindMany.mockResolvedValue([{ version: "2.14.0", consumedMergeSha: MERGE }]);
    mocks.isAncestor.mockResolvedValueOnce(false);
    expect(await findUnsyncedPublish(ctx)).toEqual({ version: "2.14.0", mergeSha: MERGE });
    mocks.isAncestor.mockResolvedValueOnce(true);
    expect(await findUnsyncedPublish(ctx)).toBeNull();
    mocks.resFindMany.mockResolvedValue([]);
    expect(await findUnsyncedPublish(ctx)).toBeNull();
  });
});
