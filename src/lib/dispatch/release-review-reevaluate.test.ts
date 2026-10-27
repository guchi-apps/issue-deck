import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const t = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00+09:00`);

const verificationFindFirst = vi.fn();
const verificationFindMany = vi.fn();
const verificationUpdateMany = vi.fn();
const jobFindFirst = vi.fn();
const revisionFindFirst = vi.fn();
const rerun = vi.fn();
const hostFindMany = vi.fn();
const repositoryFindFirst = vi.fn();
const loadOpsContext = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    releaseVerification: { findFirst: verificationFindFirst, findMany: verificationFindMany, updateMany: verificationUpdateMany },
    dispatchJob: { findFirst: jobFindFirst },
    dispatchHost: { findMany: hostFindMany },
    repository: { findFirst: repositoryFindFirst },
    releaseCandidateRevision: { findFirst: revisionFindFirst },
  },
}));
vi.mock("@/lib/dispatch/release-review-jobs", () => ({ rerunReleaseReviewJob: rerun }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn().mockResolvedValue("token") }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseOpsContext: loadOpsContext }));

const {
  explainOpsReevaluation,
  reevaluateReleaseReviewForOps,
  reevaluateReleaseReviewIfReady,
  resetReleaseReviewReevaluationSweepForTest,
  sweepReleaseReviewReevaluation,
} = await import("./release-review-reevaluate");

const target = { repoFullName: "guchi-apps/issue-deck", prNumber: 4663, baseSha: BASE, headSha: HEAD };

type Rows = {
  review?: Record<string, unknown> | null;
  integration?: Record<string, unknown> | null;
  own?: Record<string, unknown> | null;
  newer?: Record<string, unknown> | null;
  reviewJob?: Record<string, unknown> | null;
  verifyJob?: Record<string, unknown> | null;
};

/** #4663: 5:24に「検証ランナーはrunning」の未確認で終わったレビューと、5:25に合格した統合検証 */
function setup(rows: Rows = {}) {
  const review =
    rows.review === undefined
      ? {
          state: "passed",
          unverifiedScope: "検証ランナーのテスト・型検査・ビルドはrunning",
          findings: { review: { checks: [{ status: "unconfirmed" }] } },
          updatedAt: t("05:24"),
        }
      : rows.review;
  const integration = rows.integration === undefined ? { state: "passed", updatedAt: t("05:25") } : rows.integration;
  verificationFindFirst.mockImplementation(({ where, select }) => {
    if (where.kind === "ai_review" && where.createdAt) return Promise.resolve(rows.newer ?? null);
    if (where.kind === "ai_review" && select?.createdAt) return Promise.resolve(rows.own === undefined ? { createdAt: t("05:00") } : rows.own);
    if (where.kind === "ai_review") return Promise.resolve(review);
    return Promise.resolve(integration);
  });
  jobFindFirst.mockImplementation(({ where }) => {
    if (where.kind === "RELEASE_REVIEW") {
      return Promise.resolve(
        rows.reviewJob === undefined
          ? { status: "SUCCEEDED", createdAt: t("05:10"), claimedAt: t("05:10"), startedAt: t("05:11"), finishedAt: t("05:24") }
          : rows.reviewJob,
      );
    }
    return Promise.resolve(rows.verifyJob === undefined ? { targetHost: "subpc" } : rows.verifyJob);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  revisionFindFirst.mockResolvedValue({ candidate: { activeKey: "guchi-apps/issue-deck" } });
  verificationUpdateMany.mockResolvedValue({ count: 1 });
  rerun.mockResolvedValue({ ok: true, outcome: "queued" });
});

describe("reevaluateReleaseReviewIfReady", () => {
  it("統合検証を実行したホストを指定し、失敗を記録しない積み方で、印を付けて再評価を積む", async () => {
    setup();
    const now = t("05:25");
    expect(await reevaluateReleaseReviewIfReady(target, now)).toMatchObject({ action: "rerun" });
    expect(rerun).toHaveBeenCalledWith(target, now, {
      requiredHost: "subpc",
      recordNoHost: false,
      autoReevaluation: { integrationAt: t("05:25").toISOString(), requestedAt: now.toISOString() },
    });
  });

  it("SHA変更: 同じPRにより新しい対象があれば、古い結果で積まない", async () => {
    setup({ newer: { id: "newer" } });
    expect(await reevaluateReleaseReviewIfReady(target)).toMatchObject({ action: "skipped", reason: "not_current" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("候補の取消・本番反映後（候補が進行中でない）は積まない", async () => {
    setup();
    revisionFindFirst.mockResolvedValue({ candidate: { activeKey: null } });
    expect(await reevaluateReleaseReviewIfReady(target)).toMatchObject({ reason: "not_current" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("旧方式（候補の記録が無い）リリースPRは、より新しい対象が無ければ積む", async () => {
    setup();
    revisionFindFirst.mockResolvedValue(null);
    expect((await reevaluateReleaseReviewIfReady(target)).action).toBe("rerun");
  });

  it("統合検証のジョブ（証跡のホスト）が見つからなければ見送る", async () => {
    setup({ verifyJob: null });
    expect(await reevaluateReleaseReviewIfReady(target)).toMatchObject({ reason: "no_verify_host" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("ホストが不適格で積めないときは、記録を書き換えずに見送る（巡回で再試行）", async () => {
    setup();
    rerun.mockResolvedValue({ ok: false, rejection: "no_host", message: "x" });
    expect(await reevaluateReleaseReviewIfReady(target)).toMatchObject({ reason: "no_host" });
    expect(verificationUpdateMany).not.toHaveBeenCalled();
  });

  it("実行中のジョブがあれば何もしない（重複報告・手動再実行と競合しない）", async () => {
    setup({ reviewJob: { status: "RUNNING", createdAt: t("05:25"), startedAt: t("05:25") } });
    expect(await reevaluateReleaseReviewIfReady(target)).toMatchObject({ action: "none", reason: "review_active" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("自動で積んだ再評価が報告なしで終わったら、状態を条件にして失敗へ戻す", async () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    setup({
      review: { state: "waiting", unverifiedScope: null, findings: { autoReevaluation: marker }, updatedAt: t("05:25") },
      reviewJob: { status: "TIMEOUT", createdAt: t("05:25"), startedAt: null, finishedAt: t("05:40") },
    });
    expect((await reevaluateReleaseReviewIfReady(target)).action).toBe("fail_stalled");
    expect(verificationUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { ...target, kind: "ai_review", state: "waiting" },
      data: { state: "failed" },
    });
  });
});

describe("sweepReleaseReviewReevaluation", () => {
  it("直近の記録を再照合し、1分以内の2回目は間引く（再起動・通知欠落の回収）", async () => {
    setup();
    resetReleaseReviewReevaluationSweepForTest();
    verificationFindMany.mockResolvedValue([{ repoFullName: target.repoFullName, prNumber: 4663, baseSha: BASE, headSha: HEAD }]);
    await sweepReleaseReviewReevaluation(t("05:30"));
    await sweepReleaseReviewReevaluation(t("05:30"));
    // 統合検証契機と運用契機（#5111）の2本を1回の巡回で読む。2回目は両方とも間引く
    expect(verificationFindMany).toHaveBeenCalledTimes(2);
    expect(rerun).toHaveBeenCalledTimes(1);
  });
});

describe("pollerの更新を契機にした自動再評価（#5111）", () => {
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  /** pollerの再起動を要求する未確認だけが残った要確認。実行時のホストは起動時コミットC1 */
  const opsReview = (extra: Record<string, unknown> = {}) => ({
    state: "needs_check",
    unverifiedScope: null,
    findings: {
      review: { checks: [{ status: "unconfirmed", evidence: "サブPCのpollerの再起動が未確認" }] },
      hostFacts: { host: "subpc", startedCommit: C1 },
      ...extra,
    },
    updatedAt: t("05:24"),
  });
  const host = (over: Record<string, unknown> = {}) => ({
    name: "subpc",
    online: true,
    startedCommit: C2,
    commit: C2,
    releaseVerifyCapable: true,
    releaseReviewCapable: true,
    lastSelfUpdateAt: null,
    includesCandidate: true,
    ...over,
  });
  const context = (hosts = [host()], changedFiles: string[] | null = ["scripts/dispatch-poller.sh"]) => ({
    repositoryFullName: target.repoFullName,
    changedFiles,
    hosts,
  });

  beforeEach(() => {
    repositoryFindFirst.mockResolvedValue({ installation: { installationId: 1 } });
    loadOpsContext.mockResolvedValue(context());
  });

  it("起動時コミットが変わり候補を含む版で動いていれば、そのホストで、印を付けて1回積む", async () => {
    setup({ review: opsReview(), reviewJob: null });
    const now = t("06:00");
    expect(await reevaluateReleaseReviewForOps(target, now)).toEqual({ action: "rerun", host: "subpc", hostFact: `subpc@${C2}` });
    expect(rerun).toHaveBeenCalledWith(target, now, {
      requiredHost: "subpc",
      recordNoHost: false,
      opsReevaluation: { hostFact: `subpc@${C2}`, requestedAt: now.toISOString() },
    });
  });

  it("同じホストの事実で実行済み・同じ事実で積み済みなら積まない（heartbeatの反復で繰り返さない）", async () => {
    setup({ review: opsReview({ hostFacts: { host: "subpc", startedCommit: C2 } }), reviewJob: null });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "same_host_facts" });
    setup({ review: opsReview({ opsReevaluation: { hostFact: `subpc@${C2}`, requestedAt: t("05:50").toISOString() } }), reviewJob: null });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "already_reevaluated" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("事実の記録が無い旧結果は、更新済みなら1回だけ再照合する", async () => {
    setup({ review: opsReview({ hostFacts: undefined }), reviewJob: null });
    expect((await reevaluateReleaseReviewForOps(target)).action).toBe("rerun");
  });

  it("更新が不要・旧版のまま・オフライン・取得失敗では積まない", async () => {
    setup({ review: opsReview(), reviewJob: null });
    loadOpsContext.mockResolvedValueOnce(context([host()], ["src/app/page.tsx"]));
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "ops_not_needed" });
    loadOpsContext.mockResolvedValueOnce(context([host({ includesCandidate: false })]));
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "ops_needed" });
    loadOpsContext.mockResolvedValueOnce(context([host({ online: false, includesCandidate: null })]));
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "ops_unknown" });
    loadOpsContext.mockRejectedValueOnce(new Error("network"));
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "ops_unknown" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("未確認がコードの読み残しだけなら運用待ちではない", async () => {
    setup({
      review: { ...opsReview(), findings: { review: { checks: [{ status: "unconfirmed", evidence: "src/a.tsを読み切れていない" }] } } },
      reviewJob: null,
    });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "not_waiting_ops" });
    expect(loadOpsContext).not.toHaveBeenCalled();
  });

  it("候補の取消・公開済み・SHA変更後は旧結果で積まない", async () => {
    setup({ review: opsReview(), reviewJob: null });
    revisionFindFirst.mockResolvedValue({ candidate: { activeKey: null } });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "skipped", reason: "not_current" });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("ジョブの実行中は積まない（重複申告・手動再実行と競合しない）", async () => {
    setup({ review: opsReview(), reviewJob: { status: "RUNNING", createdAt: t("05:50") } });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "review_active" });
  });

  it("証跡にも依存するなら、統合検証のホストが更新済みのときだけ積む", async () => {
    const review = opsReview();
    review.findings.review.checks.push({ status: "unconfirmed", evidence: "統合検証の結果待ち" });
    setup({ review, reviewJob: null, verifyJob: { targetHost: "other" } });
    expect(await reevaluateReleaseReviewForOps(target)).toEqual({ action: "none", reason: "verify_host_not_updated" });
  });

  it("画面用の説明も同じ判定を使う", async () => {
    setup({ review: opsReview(), reviewJob: null });
    expect(await explainOpsReevaluation(target, context([host({ includesCandidate: false })]))).toEqual({
      action: "none",
      reason: "ops_needed",
    });
  });

  it("自動で積んだ再評価が報告なしで終わったら、手動の再実行へ戻す", async () => {
    setup({
      review: { state: "waiting", unverifiedScope: null, findings: { opsReevaluation: { hostFact: `subpc@${C2}`, requestedAt: t("06:00").toISOString() } }, updatedAt: t("06:00") },
      reviewJob: { status: "CANCELED", createdAt: t("06:00"), startedAt: null, finishedAt: t("06:10") },
    });
    expect((await reevaluateReleaseReviewIfReady(target)).action).toBe("fail_stalled");
  });

  it("巡回: 起動時コミットが変わったときだけ稼働情報を読み、同じ事実では10分間照合し直さない", async () => {
    setup({ review: opsReview(), reviewJob: null });
    resetReleaseReviewReevaluationSweepForTest();
    const row = { repoFullName: target.repoFullName, prNumber: 4663, baseSha: BASE, headSha: HEAD, ...opsReview() };
    verificationFindMany.mockImplementation(({ where }) => Promise.resolve(where.state === "needs_check" ? [row] : []));
    const declared = { name: "subpc", lastSeenAt: t("06:00"), repositories: JSON.stringify([target.repoFullName]), releaseReviewCapable: true };
    // 実行時と同じ起動時コミット（heartbeatの反復だけ）
    hostFindMany.mockResolvedValue([{ ...declared, checkoutStartedCommit: C1 }]);
    await sweepReleaseReviewReevaluation(t("06:00"));
    expect(loadOpsContext).not.toHaveBeenCalled();
    // 更新・再起動で起動時コミットが変わった
    hostFindMany.mockResolvedValue([{ ...declared, checkoutStartedCommit: C2, lastSeenAt: t("06:02") }]);
    rerun.mockResolvedValue({ ok: false, rejection: "no_host" });
    await sweepReleaseReviewReevaluation(t("06:02"));
    expect(loadOpsContext).toHaveBeenCalledTimes(1);
    await sweepReleaseReviewReevaluation(t("06:04"));
    expect(loadOpsContext).toHaveBeenCalledTimes(1);
  });
});
