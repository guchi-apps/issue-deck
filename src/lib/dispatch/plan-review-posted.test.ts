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

describe("markPlanReviewPosted（#3659）", () => {
  beforeEach(() => {
    findJob.mockReset();
    updateJob.mockReset();
  });

  it("計画レビューのコメントでなければ何もしない", async () => {
    expect(await markPlanReviewPosted(params("ただのコメント"))).toBe(false);
    expect(findJob).not.toHaveBeenCalled();
  });

  it("コメントより前に積まれた最新のSUCCEEDEDジョブへ届いた時刻を記録する", async () => {
    findJob.mockResolvedValue({ id: "job-1", reviewPostedAt: null });

    expect(await markPlanReviewPosted(params(REVIEW))).toBe(true);
    expect(findJob).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryFullName: "guchi-apps/issue-deck",
          issueNumber: 3659,
          kind: "PLAN_REVIEW",
          status: "SUCCEEDED",
          createdAt: { lte: POSTED_AT },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(updateJob).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { reviewPostedAt: POSTED_AT },
    });
  });

  it("記録済みなら上書きしない", async () => {
    findJob.mockResolvedValue({ id: "job-1", reviewPostedAt: new Date("2026-09-30T11:58:00Z") });

    expect(await markPlanReviewPosted(params(REVIEW))).toBe(false);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("対象のジョブが無ければ何もしない", async () => {
    findJob.mockResolvedValue(null);

    expect(await markPlanReviewPosted(params(REVIEW))).toBe(false);
    expect(updateJob).not.toHaveBeenCalled();
  });
});
