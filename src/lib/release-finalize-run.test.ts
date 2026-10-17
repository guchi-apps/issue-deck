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
  ensureSync: vi.fn(async () => ({ state: "synced" })),
  fetchPr: vi.fn(),
  records: vi.fn(async () => [] as unknown[]),
  register: vi.fn(),
  verifyJob: vi.fn(),
  reviewJob: vi.fn(),
  macRows: vi.fn(async () => [] as unknown[]),
  developHead: vi.fn(),
  openPrs: vi.fn(),
  createPr: vi.fn(),
  prepareApproval: vi.fn(),
  commitApproval: vi.fn(async () => "pa1"),
  ensureRun: vi.fn(async () => ({ ok: true, runId: "run1", created: true })),
  observeProduction: vi.fn(),
  recordVerified: vi.fn(async () => undefined),
  candFindUnique: vi.fn(async () => null as unknown),
  candFindFirst: vi.fn(async () => null as unknown),
  observeSuccessor: vi.fn(async () => ({ ok: false }) as unknown),
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
    releaseCandidate: { updateMany: mocks.candUpdateMany, findUnique: mocks.candFindUnique, findFirst: mocks.candFindFirst },
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
vi.mock("@/lib/release-develop-sync-run", () => ({ ensureDevelopSync: mocks.ensureSync }));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequest: mocks.fetchPr }));
vi.mock("@/lib/github/actions-api", () => ({ markPullRequestReadyForReview: vi.fn() }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/release-production-verification-run", () => ({
  observeProduction: mocks.observeProduction,
  recordProductionVerified: mocks.recordVerified,
  loadProductionView: vi.fn(async () => null),
}));
vi.mock("@/lib/release-production-stop-run", () => ({ observeSuccessorProof: mocks.observeSuccessor }));
vi.mock("@/lib/release-verification", () => ({
  listReleaseVerificationRecords: mocks.records,
  registerReleaseVerification: mocks.register,
  listReleaseVerificationDetails: vi.fn(async () => {
    throw new Error("not mocked");
  }),
}));
vi.mock("@/lib/release-mac-verification", () => ({ listReleaseMacRows: mocks.macRows }));
vi.mock("@/lib/dispatch/release-verify-jobs", () => ({ requestReleaseVerifyJob: mocks.verifyJob }));
vi.mock("@/lib/dispatch/release-review-jobs", () => ({ requestReleaseReviewJob: mocks.reviewJob }));
vi.mock("@/lib/release-publish-approval-run", () => ({
  preparePublishApproval: mocks.prepareApproval,
  commitPublishApproval: mocks.commitApproval,
  ensurePublishApprovalRun: mocks.ensureRun,
  loadPublishApprovalView: vi.fn(async () => null),
  revokePublishApproval: vi.fn(),
}));

import * as releaseApi from "@/lib/github/release-api";
import { recheckRcProduction, reconcileRcFinalization, recordFinalizeReport, requestRcFinalize } from "@/lib/release-finalize-run";

const CALLER = "    inputs:\n      finalize_request:\n    with:\n      finalize-request: x\n";
const BASE = "b".repeat(40);
const PRE = "a".repeat(40);
const POST = "c".repeat(40);
const ctx = { owner: "o", repo: "r", token: "t" };

const contract = { candidateId: "c1", sequence: 3, revision: 2, prNumber: 10, baseSha: BASE, headSha: PRE, frozenDevelopSha: "f".repeat(40), includedPrs: [1] };

function overview(over: Record<string, unknown> = {}) {
  return { candidate: { id: "c1", sequence: 3, phase: "review", finalizeContract: contract, frozenPrs: [{ number: 1, title: "t", mergeSha: "m" }], ...over } };
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
  mocks.prepareApproval.mockResolvedValue({ kind: "create", data: {} });
  mocks.commitApproval.mockResolvedValue("pa1");
  mocks.ensureRun.mockResolvedValue({ ok: true, runId: "run1", created: true });
});

describe("requestRcFinalize の公開承認（#4666）", () => {
  const input = { ...ctx, userId: "u1", candidateId: "c1", expectedHeadSha: PRE, bumpKind: "minor" as const, requestKey: "reqkey0101", approvePublish: true };

  it("承認の明示が無い要求（古い画面）は、版の予約・段階の変更・workflowの起動をしない", async () => {
    const result = await requestRcFinalize({ ...input, approvePublish: false });
    expect(result).toMatchObject({ ok: false, error: "approval_required" });
    expect(mocks.candUpdateMany).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.prepareApproval).not.toHaveBeenCalled();
  });

  it("承認者・押した時点の候補（revision・base/head）・公開内容・版指定方針を承認として渡し、同じ処理の中で確定する", async () => {
    await requestRcFinalize(input);
    expect(mocks.prepareApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "c1",
        userId: "u1",
        bumpPolicy: "minor",
        contract: expect.objectContaining({ revision: 2, prNumber: 10, baseSha: BASE, headSha: PRE }),
        contents: [{ number: 1, title: "t" }],
      }),
    );
    expect(mocks.commitApproval).toHaveBeenCalledTimes(1);
    expect(mocks.ensureRun).toHaveBeenCalledWith(expect.objectContaining({ owner: "o" }), "pa1");
  });

  it("別の候補の完了系列が進行中なら、公開準備を始めない", async () => {
    mocks.prepareApproval.mockResolvedValue({ kind: "conflict", error: "run_active", message: "進行中" });
    const result = await requestRcFinalize(input);
    expect(result).toEqual({ ok: false, error: "run_active", message: "進行中" });
    expect(mocks.candUpdateMany).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("workflowを起動できなければ、自動公開の系列を始めない（承認は残し、再試行で使い回す）", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("boom"));
    mocks.finFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "f1", candidateId: "c1" });
    const result = await requestRcFinalize(input);
    expect(result).toMatchObject({ ok: false, error: "dispatch_failed" });
    expect(mocks.ensureRun).not.toHaveBeenCalled();
  });
});

describe("requestRcFinalize", () => {
  const input = { ...ctx, userId: "u1", candidateId: "c1", expectedHeadSha: PRE, bumpKind: "minor" as const, requestKey: "reqkey0001", approvePublish: true };

  it("合格した候補だけ、版を予約してから段階を進め、workflowへ固定した前提を渡す", async () => {
    const result = await requestRcFinalize(input);
    expect(result).toEqual({ ok: true, finalizationId: "f1", existing: false, approvalId: "pa1" });
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

  it("段階を確保できなかった要求は、予約台帳を変更しない", async () => {
    mocks.resFindMany.mockResolvedValue([{ id: "r1", version: "2.14.0", candidateId: "c1", status: "reserved" }]);
    mocks.candUpdateMany.mockResolvedValueOnce({ count: 0 });
    const r = await requestRcFinalize({ ...input, bumpKind: "major", requestKey: "reqkey0004" });
    expect(r).toEqual({ ok: false, error: "wrong_phase" });
    expect(mocks.resUpdateMany).not.toHaveBeenCalled();
    expect(mocks.resCreate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("予約を取れなければversion_conflictで、workflowを起動しない", async () => {
    mocks.resCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const r = await requestRcFinalize({ ...input, requestKey: "reqkey0005" });
    expect(r).toMatchObject({ ok: false, error: "version_conflict" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
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

describe("reconcileRcFinalization（系列がマージした後。#4666）", () => {
  it("自動公開の系列がマージした候補は、公開準備側が1回だけ本番反映へ進め、版の予約を1回だけ消費する", async () => {
    mocks.loadCandidateRow.mockResolvedValue({ id: "c1", sequence: 3, phase: "awaiting_approval", revisions: [{ revision: 3 }] });
    mocks.finFindMany.mockResolvedValue([
      { id: "f1", candidateId: "c1", status: "applied", prNumber: 10, preBaseSha: BASE, preHeadSha: PRE, finalBaseSha: BASE, finalHeadSha: POST, reservedVersion: "2.14.0", failureReason: null, createdAt: new Date() },
    ]);
    mocks.observePr.mockResolvedValue({ number: 10, state: "closed", head: { sha: POST }, base: { sha: BASE } });
    mocks.fetchPr.mockResolvedValue({ number: 10, merged: true, merged_at: null, merge_commit_sha: "m1", draft: false, head: { sha: POST }, base: { sha: BASE } });
    vi.mocked(releaseApi.fetchPullRequestCiState).mockResolvedValue({ ciState: "success" } as never);
    mocks.records.mockResolvedValue([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: POST },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: POST },
    ]);
    // 1回目の巡回だけが段階の条件付き更新を取れる（同時の巡回・重複した呼び出しは0件）
    mocks.candUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    await reconcileRcFinalization(ctx, "c1");
    await reconcileRcFinalization(ctx, "c1");

    expect(mocks.candUpdateMany).toHaveBeenCalledWith({ where: { id: "c1", phase: "awaiting_approval" }, data: { phase: "deploying" } });
    const consumed = mocks.resUpdateMany.mock.calls.filter((call) => (call as unknown as [{ data: { status?: string } }])[0].data.status === "consumed");
    expect(consumed).toHaveLength(1);
  });
});

describe("reconcileRcFinalization（mainへ出した後の稼働版の確認。#4713）", () => {
  const MERGE = "d".repeat(40);
  const succeededRun = { id: 1, htmlUrl: "https://github.com/o/r/actions/runs/1", createdAt: "2026-10-17T00:00:00Z", headSha: MERGE, status: "completed", conclusion: "success", attempt: 1 };

  beforeEach(() => {
    mocks.loadCandidateRow.mockResolvedValue({ id: "c1", sequence: 3, phase: "verifying_production", revisions: [{ revision: 3 }] });
    mocks.finFindMany.mockResolvedValue([
      { id: "f1", candidateId: "c1", status: "applied", prNumber: 10, preBaseSha: BASE, preHeadSha: PRE, finalBaseSha: BASE, finalHeadSha: POST, reservedVersion: "2.14.0", failureReason: null, createdAt: new Date() },
    ]);
    mocks.observePr.mockResolvedValue({ number: 10, state: "closed", head: { sha: POST }, base: { sha: BASE } });
    mocks.fetchPr.mockResolvedValue({ number: 10, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: MERGE, draft: false, head: { sha: POST }, base: { sha: BASE } });
    mocks.tagRefs.mockResolvedValue([{ ref: "refs/tags/v2.14.0", sha: MERGE }]);
    // 前のdescribeが積んだ戻り値（clearAllMocksでは消えない）を戻す
    mocks.candUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  const completedCalls = () =>
    mocks.candUpdateMany.mock.calls.filter((call) => (call as unknown as [{ data: { phase?: string } }])[0].data.phase === "completed");

  it("公開URLのSHAが一致したら、候補を完了にして進行中の印を外し、方式と証拠を残す", async () => {
    mocks.observeProduction.mockResolvedValue({
      kind: "deploy_without_version_check",
      runs: [succeededRun],
      decision: { verified: true, method: "public_version_url" },
      evidence: { mergeSha: MERGE, probe: { status: "match" } },
    });

    await reconcileRcFinalization(ctx, "c1");

    expect(mocks.observeProduction).toHaveBeenCalledWith(ctx, { candidateId: "c1", mergeSha: MERGE, version: "2.14.0" });
    expect(mocks.candUpdateMany).toHaveBeenCalledWith({
      where: { id: "c1", phase: "verifying_production" },
      data: { phase: "completed", activeKey: null, successorProofKey: null, productionStopReason: null, productionStopDetail: null },
    });
    expect(mocks.recordVerified).toHaveBeenCalledWith("c1", "public_version_url", expect.objectContaining({ mergeSha: MERGE, tag: "v2.14.0" }));
    expect(mocks.resUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ candidateId: "c1", version: "2.14.0" }) }));
  });

  it.each([
    ["旧版が応答した", "version_mismatch"],
    ["公開URLを取得できない", "probe_unreadable"],
    ["証拠が無い（deployのHTTP 200だけ）", "no_evidence"],
  ])("%s間は完了にせず、進行中の印も外さない", async (_label, reason) => {
    mocks.observeProduction.mockResolvedValue({ kind: "deploy_without_version_check", runs: [succeededRun], decision: { verified: false, reason }, evidence: {} });

    await reconcileRcFinalization(ctx, "c1");

    expect(completedCalls()).toHaveLength(0);
    expect(mocks.recordVerified).not.toHaveBeenCalled();
  });

  it("ソース配布のrepoは、deploy runが無くてもソース公開の証拠で完了にする", async () => {
    mocks.observeProduction.mockResolvedValue({ kind: "source_publish_only", runs: [], decision: { verified: true, method: "source_publish" }, evidence: { deviceDeployment: "out_of_scope" } });

    await reconcileRcFinalization(ctx, "c1");

    expect(completedCalls()).toHaveLength(1);
    expect(mocks.recordVerified).toHaveBeenCalledWith("c1", "source_publish", expect.objectContaining({ deviceDeployment: "out_of_scope" }));
  });

  it("ソース公開を確認できない間は完了にしない", async () => {
    mocks.observeProduction.mockResolvedValue({ kind: "source_publish_only", runs: [], decision: { verified: false, reason: "source_not_published" }, evidence: {} });

    await reconcileRcFinalization(ctx, "c1");

    expect(completedCalls()).toHaveLength(0);
  });
});

describe("reconcileRcFinalization（稼働確認の停止と後続の版による確認。#4712）", () => {
  const MERGE = "d".repeat(40);
  const NEXT = "e".repeat(40);
  const MERGED_AT = "2026-10-16T22:46:02Z";
  const succeededRun = { id: 1, htmlUrl: "https://github.com/o/r/actions/runs/38977690006", createdAt: MERGED_AT, headSha: MERGE, status: "completed", conclusion: "success", attempt: 1 };
  const candidate = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    sequence: 1,
    phase: "verifying_production",
    activeKey: "o/r",
    successorProofKey: null,
    productionStopReason: null,
    productionStopDetail: null,
    productionCheckStartedAt: null,
    revisions: [],
    ...over,
  });
  const noEvidence = { kind: "deploy_without_version_check", runs: [succeededRun], decision: { verified: false, reason: "no_evidence" }, evidence: {} };
  const stopUpdates = () =>
    mocks.candUpdateMany.mock.calls
      .map((call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data)
      .filter((data) => "productionStopReason" in data && !("phase" in data));
  const completion = () =>
    mocks.candUpdateMany.mock.calls
      .map((call) => (call as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0])
      .find((call) => call.data.phase === "completed");

  beforeEach(() => {
    mocks.finFindMany.mockResolvedValue([
      { id: "f1", candidateId: "c1", status: "applied", prNumber: 10, preBaseSha: BASE, preHeadSha: PRE, finalBaseSha: BASE, finalHeadSha: POST, reservedVersion: "1.4.0", failureReason: null, createdAt: new Date() },
    ]);
    mocks.observePr.mockResolvedValue({ number: 10, state: "closed", head: { sha: POST }, base: { sha: BASE } });
    mocks.fetchPr.mockResolvedValue({ number: 254, merged: true, merged_at: MERGED_AT, merge_commit_sha: MERGE, draft: false, head: { sha: POST }, base: { sha: BASE } });
    mocks.candUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.resUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.candFindUnique.mockReset().mockResolvedValue(null);
    mocks.observeSuccessor.mockReset().mockResolvedValue({ ok: false });
  });

  it("証拠未設定（car-care RC-1）は完了・解放せず、理由を記録して「稼働確認中」を出し続けない", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate());
    mocks.observeProduction.mockResolvedValue(noEvidence);
    await reconcileRcFinalization(ctx, "c1");
    expect(stopUpdates()).toEqual([{ productionStopReason: "contract_missing", productionStopDetail: succeededRun.htmlUrl }]);
    expect(completion()).toBeUndefined();
    expect(mocks.recordVerified).not.toHaveBeenCalled();
    expect(mocks.resUpdateMany).not.toHaveBeenCalled();
  });

  it("同じ理由で止まったままなら書き直さない（巡回のたびにDBへ書かない）", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate({ productionStopReason: "contract_missing", productionStopDetail: succeededRun.htmlUrl }));
    mocks.observeProduction.mockResolvedValue(noEvidence);
    await reconcileRcFinalization(ctx, "c1");
    expect(stopUpdates()).toEqual([]);
  });

  it("旧版の応答は「旧版が応答」として記録し、後続の版で代用しない", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate());
    mocks.observeProduction.mockResolvedValue({ ...noEvidence, decision: { verified: false, reason: "version_mismatch" } });
    mocks.observeSuccessor.mockResolvedValue({ ok: true, evidence: { coveredSha: MERGE, successorSha: NEXT, deployRunUrl: "u2" } });
    await reconcileRcFinalization(ctx, "c1");
    expect(stopUpdates()).toEqual([{ productionStopReason: "version_mismatch", productionStopDetail: succeededRun.htmlUrl }]);
    expect(mocks.observeSuccessor).not.toHaveBeenCalled();
    expect(completion()).toBeUndefined();
  });

  it("止まった後に再実行が始まれば、停止の記録を消してデプロイの進行へ戻す", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate({ phase: "deploying", productionStopReason: "deploy_failed", productionStopDetail: "u" }));
    mocks.observeProduction.mockResolvedValue({ ...noEvidence, runs: [{ ...succeededRun, id: 2, status: "in_progress", conclusion: null, attempt: 2 }], decision: { verified: false, reason: "deploy_not_succeeded" } });
    await reconcileRcFinalization(ctx, "c1");
    expect(stopUpdates()).toEqual([{ productionStopReason: null, productionStopDetail: null }]);
    expect(completion()).toBeUndefined();
  });

  it("証拠未設定の候補は、照合付きの後続の版の稼働を確かめた時点で「後続の版」として完了する", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate({ activeKey: null, successorProofKey: "o/r", productionStopReason: "contract_missing" }));
    mocks.observeProduction.mockResolvedValue(noEvidence);
    mocks.observeSuccessor.mockResolvedValue({ ok: true, evidence: { coveredSha: MERGE, successorSha: NEXT, deployRunUrl: "u2" } });
    await reconcileRcFinalization(ctx, "c1");
    expect(mocks.observeSuccessor).toHaveBeenCalledWith(ctx, MERGE);
    expect(completion()?.data).toMatchObject({ phase: "completed", activeKey: null, successorProofKey: null, productionStopReason: null });
    expect(mocks.recordVerified).toHaveBeenCalledWith("c1", "successor", expect.objectContaining({ coveredSha: MERGE, successorSha: NEXT }));
  });

  it("証拠を確かめて完了した候補は、後続の確認を待つ候補を同じ巡回で確かめ直す", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate());
    mocks.observeProduction.mockResolvedValue({ kind: "deploy_version_check", runs: [succeededRun], decision: { verified: true, method: "deploy_version_check" }, evidence: { mergeSha: MERGE } });
    mocks.candFindUnique.mockResolvedValueOnce({ id: "c0" }).mockResolvedValue(null);
    await reconcileRcFinalization(ctx, "c1");
    expect(completion()).toBeDefined();
    expect(mocks.candFindUnique).toHaveBeenCalledWith({ where: { successorProofKey: "o/r" }, select: { id: true } });
    expect(mocks.loadCandidateRow).toHaveBeenCalledWith({ id: "c0" });
  });

  it("「稼働確認をやり直す」の時刻があれば、待ち時間をそこから数える（期限切れの停止を取り直す）", async () => {
    mocks.loadCandidateRow.mockResolvedValue(candidate({ phase: "deploying", productionCheckStartedAt: new Date() }));
    mocks.observeProduction.mockResolvedValue({ ...noEvidence, runs: [], decision: { verified: false, reason: "deploy_not_succeeded" } });
    await reconcileRcFinalization(ctx, "c1");
    // マージ時刻からは60分を過ぎているが、やり直した時刻からは過ぎていないので止めない
    expect(stopUpdates()).toEqual([]);
  });

  it("recheckRcProduction: 止まっていない候補は確かめ直さない（証拠を代わりに書かない）", async () => {
    mocks.candUpdateMany.mockResolvedValue({ count: 0 });
    mocks.candFindFirst.mockResolvedValue({ id: "c1" });
    mocks.observeProduction.mockClear();
    expect(await recheckRcProduction(ctx, "c1")).toEqual({ ok: false, error: "not_stopped" });
    expect(mocks.observeProduction).not.toHaveBeenCalled();
    const call = (mocks.candUpdateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(call.where).toMatchObject({ productionStopReason: { not: null } });
    expect(Object.keys(call.data).sort()).toEqual(["productionCheckStartedAt", "productionStopDetail", "productionStopReason"]);
  });
});
