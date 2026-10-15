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

vi.mock("@/lib/db", () => ({
  db: {
    releaseVerification: { findFirst: verificationFindFirst, findMany: verificationFindMany, updateMany: verificationUpdateMany },
    dispatchJob: { findFirst: jobFindFirst },
    releaseCandidateRevision: { findFirst: revisionFindFirst },
  },
}));
vi.mock("@/lib/dispatch/release-review-jobs", () => ({ rerunReleaseReviewJob: rerun }));

const { reevaluateReleaseReviewIfReady, resetReleaseReviewReevaluationSweepForTest, sweepReleaseReviewReevaluation } =
  await import("./release-review-reevaluate");

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
    expect(verificationFindMany).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledTimes(1);
  });
});
