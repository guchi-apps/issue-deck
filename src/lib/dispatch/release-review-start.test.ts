import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-10-18T10:00:00+09:00");

const verificationFindFirst = vi.fn();
const verificationFindMany = vi.fn();
const verificationUpdateMany = vi.fn();
const jobFindFirst = vi.fn();
const requestJob = vi.fn();
const isCurrent = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    releaseVerification: { findFirst: verificationFindFirst, findMany: verificationFindMany, updateMany: verificationUpdateMany },
    dispatchJob: { findFirst: jobFindFirst },
  },
}));
vi.mock("@/lib/dispatch/release-review-jobs", () => ({ requestReleaseReviewJob: requestJob }));
vi.mock("@/lib/dispatch/release-review-reevaluate", () => ({ isCurrentReleaseReviewTarget: isCurrent }));

const {
  requestReleaseReviewAfterIntegration,
  resetDeferredReleaseReviewSweepForTest,
  startDeferredReleaseReview,
  sweepDeferredReleaseReviews,
} = await import("./release-review-start");

const target = { repoFullName: "guchi-apps/issue-deck", prNumber: 4763, baseSha: BASE, headSha: HEAD };
const MARKER = { awaitingIntegration: { since: "2026-10-18T00:30:00.000Z" } };

type Rows = {
  review?: { state: string; findings: unknown } | null;
  integration?: { state: string; createdAt: Date } | null;
  verifyJob?: { status: string; targetHost: string; claimedAt: Date | null } | null;
};

function setup(rows: Rows) {
  verificationFindFirst.mockImplementation(({ where }) =>
    Promise.resolve(where.kind === "integration" ? (rows.integration ?? null) : (rows.review ?? null)),
  );
  jobFindFirst.mockResolvedValue(rows.verifyJob ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeferredReleaseReviewSweepForTest();
  verificationUpdateMany.mockResolvedValue({ count: 1 });
  requestJob.mockResolvedValue({ ok: true, outcome: "queued", job: { id: "r1" } });
  isCurrent.mockResolvedValue(true);
});

describe("requestReleaseReviewAfterIntegration", () => {
  it("統合検証のジョブが動いている間は積まず、待機の印を付けて待たせる", async () => {
    setup({
      review: { state: "waiting", findings: null },
      integration: { state: "waiting", createdAt: NOW },
      verifyJob: { status: "QUEUED", targetHost: "subpc", claimedAt: null },
    });
    expect(await requestReleaseReviewAfterIntegration(target, NOW)).toEqual({ ok: true, outcome: "deferred" });
    expect(requestJob).not.toHaveBeenCalled();
    expect(verificationUpdateMany).toHaveBeenCalledWith({
      where: { ...target, kind: "ai_review", state: "waiting" },
      data: { findings: { awaitingIntegration: { since: NOW.toISOString() } } },
    });
  });

  it("結果の出た記録には待機の印を付けない", async () => {
    setup({
      review: { state: "needs_check", findings: { findings: [] } },
      integration: { state: "running", createdAt: NOW },
      verifyJob: { status: "RUNNING", targetHost: "subpc", claimedAt: NOW },
    });
    expect(await requestReleaseReviewAfterIntegration(target, NOW)).toEqual({ ok: true, outcome: "deferred" });
    expect(verificationUpdateMany).not.toHaveBeenCalled();
  });

  it("統合検証が終わっていれば、実行したホストを優先して積み、待機の印を外す", async () => {
    setup({
      review: { state: "waiting", findings: { ...MARKER, previousRun: { state: "failed", at: "x" } } },
      integration: { state: "passed", createdAt: NOW },
      verifyJob: { status: "SUCCEEDED", targetHost: "verify-host", claimedAt: NOW },
    });
    expect(await requestReleaseReviewAfterIntegration(target, NOW)).toMatchObject({ ok: true, outcome: "queued" });
    expect(requestJob).toHaveBeenCalledWith(target, NOW, { preferredHost: "verify-host" });
    expect(verificationUpdateMany).toHaveBeenCalledWith({
      where: { ...target, kind: "ai_review", state: "waiting" },
      data: { findings: { previousRun: { state: "failed", at: "x" } } },
    });
  });

  it("一度も取得されずに期限切れになった統合検証のジョブのホストは優先しない（#4775）", async () => {
    setup({
      review: { state: "waiting", findings: MARKER },
      integration: { state: "waiting", createdAt: NOW },
      verifyJob: { status: "TIMEOUT", targetHost: "verify-host", claimedAt: null },
    });
    expect(await requestReleaseReviewAfterIntegration(target, NOW)).toMatchObject({ outcome: "queued" });
    expect(requestJob).toHaveBeenCalledWith(target, NOW, { preferredHost: null });
  });

  it("統合検証の記録が無ければ（引き継いだ・未依頼）待たずに積む", async () => {
    setup({ review: { state: "waiting", findings: null }, integration: null });
    expect(await requestReleaseReviewAfterIntegration(target, NOW)).toMatchObject({ outcome: "queued" });
    expect(requestJob).toHaveBeenCalledWith(target, NOW, { preferredHost: null });
  });
});

describe("startDeferredReleaseReview", () => {
  it("待たせていない記録には何もしない（通常の待機・結果の出た記録）", async () => {
    setup({ review: { state: "waiting", findings: null }, integration: { state: "passed", createdAt: NOW } });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "skipped", reason: "not_deferred" });
    setup({ review: { state: "passed", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "skipped", reason: "not_deferred" });
    expect(requestJob).not.toHaveBeenCalled();
  });

  it("統合検証の完了報告のあと、待たせていたレビューを開始する（失敗した統合検証でも開始する）", async () => {
    setup({
      review: { state: "waiting", findings: MARKER },
      integration: { state: "failed", createdAt: NOW },
      verifyJob: { status: "FAILED", targetHost: "verify-host", claimedAt: NOW },
    });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "started", outcome: "queued" });
    expect(requestJob).toHaveBeenCalledWith(target, NOW, { preferredHost: "verify-host" });
  });

  it("古い対象は開始しない（同じPRの新しい対象の待機中ジョブを取り消さない）", async () => {
    isCurrent.mockResolvedValue(false);
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "skipped", reason: "not_current" });
    expect(requestJob).not.toHaveBeenCalled();
  });

  it("統合検証がまだ動いていれば待ち続ける", async () => {
    setup({
      review: { state: "waiting", findings: MARKER },
      integration: { state: "waiting", createdAt: NOW },
      verifyJob: { status: "RUNNING", targetHost: "verify-host", claimedAt: NOW },
    });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "skipped", reason: "still_waiting" });
  });

  it("積めるホストが無ければno_host（失敗の記録は積む側が行う）", async () => {
    requestJob.mockResolvedValue({ ok: false, rejection: "no_host", message: "x" });
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    expect(await startDeferredReleaseReview(target, NOW)).toEqual({ action: "skipped", reason: "no_host" });
  });
});

describe("sweepDeferredReleaseReviews", () => {
  it("待機の印がある記録だけを開始し、1分に1回までに間引く", async () => {
    verificationFindMany.mockResolvedValue([
      { ...target, findings: MARKER },
      { ...target, prNumber: 1, findings: null },
    ]);
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    await sweepDeferredReleaseReviews(NOW);
    expect(requestJob).toHaveBeenCalledTimes(1);
    expect(requestJob.mock.calls[0][0]).toEqual(target);
    await sweepDeferredReleaseReviews(new Date(NOW.getTime() + 30_000));
    expect(verificationFindMany).toHaveBeenCalledTimes(1);
  });

  /** `skip`・`take`どおりに切り出して返す（実際のページングを模す） */
  function serveRows(rows: Array<Record<string, unknown>>) {
    verificationFindMany.mockImplementation(({ skip, take }: { skip: number; take: number }) =>
      Promise.resolve(rows.slice(skip, skip + take)),
    );
  }

  it("印の無い古い待機行が多数あっても、印付きの対象を拾う（印の無い行は上限に数えない。#4775）", async () => {
    const stale = Array.from({ length: 250 }, (_, i) => ({ ...target, prNumber: 10_000 + i, findings: null }));
    serveRows([...stale, { ...target, findings: MARKER }]);
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    await sweepDeferredReleaseReviews(NOW);
    expect(requestJob).toHaveBeenCalledTimes(1);
    expect(requestJob.mock.calls[0][0]).toEqual(target);
    expect(verificationFindMany).toHaveBeenCalledTimes(3);
  });

  it("currentでない印付きの行は上限に数えず、その後ろの待機中の対象を拾う（#4775）", async () => {
    const old = Array.from({ length: 80 }, (_, i) => ({ ...target, prNumber: 20_000 + i, findings: MARKER }));
    serveRows([...old, { ...target, findings: MARKER }]);
    isCurrent.mockImplementation((t: { prNumber: number }) => Promise.resolve(t.prNumber === target.prNumber));
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    await sweepDeferredReleaseReviews(NOW);
    expect(requestJob).toHaveBeenCalledTimes(1);
    expect(requestJob.mock.calls[0][0]).toEqual(target);
  });

  it("印付きでcurrentな対象は1回の巡回で50件までにする", async () => {
    serveRows(Array.from({ length: 70 }, (_, i) => ({ ...target, prNumber: 30_000 + i, findings: MARKER })));
    setup({ review: { state: "waiting", findings: MARKER }, integration: { state: "passed", createdAt: NOW } });
    await sweepDeferredReleaseReviews(NOW);
    expect(requestJob).toHaveBeenCalledTimes(50);
  });
});
