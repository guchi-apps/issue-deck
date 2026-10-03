import { beforeEach, describe, expect, it, vi } from "vitest";

const findJob = vi.fn();
const updateJob = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchJob: {
      findFirst: (...a: unknown[]) => findJob(...a),
      update: (...a: unknown[]) => updateJob(...a),
    },
  },
}));

const { markPlanReviewPosted } = await import("@/lib/dispatch/plan-review-posted");

const REVIEW = "## 計画レビュー（G1）\n\n指摘なし。\n\n<!-- supervisor:plan-review -->";
const POSTED_AT = new Date("2026-09-30T12:00:00Z");

const params = (commentBody: string) => ({
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 3659,
  commentBody,
  commentCreatedAt: POSTED_AT,
});

describe("markPlanReviewPosted（#3659・#3648）", () => {
  beforeEach(() => {
    findJob.mockReset();
    updateJob.mockReset();
  });

  it("計画レビューのコメントでなければ何もしない", async () => {
    expect(await markPlanReviewPosted(params("ただのコメント"))).toBeNull();
    expect(findJob).not.toHaveBeenCalled();
  });

  it("未記入のSUCCEEDEDジョブのうち、15分以内で最も古いものへ届いた時刻を記録し、そのジョブを返す", async () => {
    const createdAt = new Date("2026-09-30T11:55:00Z");
    findJob.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-1", createdAt });

    expect(await markPlanReviewPosted(params(REVIEW))).toEqual({ jobId: "job-1", createdAt });
    expect(findJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          repositoryFullName: "guchi-apps/issue-deck",
          issueNumber: 3659,
          kind: "PLAN_REVIEW",
          status: "SUCCEEDED",
          reviewPostedAt: null,
          createdAt: { gte: new Date("2026-09-30T11:45:00Z"), lte: POSTED_AT },
        },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(updateJob).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { reviewPostedAt: POSTED_AT },
    });
  });

  it("レビューを実行したCLIで絞らず、CodexのG1レビューも記録できる", async () => {
    const createdAt = new Date("2026-09-30T11:55:00Z");
    findJob.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "codex-job-1", createdAt });

    await expect(markPlanReviewPosted(params(REVIEW))).resolves.toEqual({ jobId: "codex-job-1", createdAt });

    const where = findJob.mock.calls[1][0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty("agent");
    expect(updateJob).toHaveBeenCalledWith({
      where: { id: "codex-job-1" },
      data: { reviewPostedAt: POSTED_AT },
    });
  });

  it("同じコメントを既に記録していれば（Webhookの再送）、次のジョブへは記録しない", async () => {
    findJob.mockResolvedValueOnce({ id: "job-1" });

    expect(await markPlanReviewPosted(params(REVIEW))).toBeNull();
    expect(findJob).toHaveBeenCalledTimes(1);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("対象のジョブが無ければ何もしない（投稿されず終わった古いジョブは候補から外れる）", async () => {
    findJob.mockResolvedValue(null);

    expect(await markPlanReviewPosted(params(REVIEW))).toBeNull();
    expect(updateJob).not.toHaveBeenCalled();
  });
});
