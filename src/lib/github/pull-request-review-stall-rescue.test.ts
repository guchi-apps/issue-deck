import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repositoryFindMany: vi.fn(),
  deleteMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  pushFindMany: vi.fn(),
  fetchOpenPullRequests: vi.fn(),
  fetchPullRequestRollups: vi.fn(),
  rerunPullRequestReview: vi.fn(),
  rerunPullRequestAutoMerge: vi.fn(),
  sendPushNotification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: { findMany: mocks.repositoryFindMany },
    pullRequestReviewStallRescue: {
      deleteMany: mocks.deleteMany,
      findUnique: mocks.findUnique,
      create: mocks.create,
      updateMany: mocks.updateMany,
    },
    pushSubscription: { findMany: mocks.pushFindMany },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn().mockResolvedValue("token") }));
vi.mock("@/lib/github/check-rollup", () => ({
  fetchPullRequestRollups: mocks.fetchPullRequestRollups,
  pullRequestRollupKey: (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`,
}));
vi.mock("@/lib/github/pull-request-review-rerun-run", () => ({ rerunPullRequestReview: mocks.rerunPullRequestReview }));
vi.mock("@/lib/github/pull-request-auto-merge-rerun", () => ({ rerunPullRequestAutoMerge: mocks.rerunPullRequestAutoMerge }));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchOpenPullRequests: mocks.fetchOpenPullRequests }));
vi.mock("@/lib/notifications/push", () => ({ sendPushNotification: mocks.sendPushNotification }));

import {
  REVIEW_STALL_MAX_ATTEMPTS_PER_PULL_REQUEST,
  REVIEW_STALL_NOTIFY_GRACE_MS,
  buildReviewStallPushPayload,
  decideReviewStallRescue,
  resetReviewStallRescueIntervalForTest,
  runReviewStallRescueSweep,
  type ReviewStallInput,
} from "@/lib/github/pull-request-review-stall-rescue";

const now = new Date("2026-11-04T12:00:00Z");
const stalled = { job: "review-provider", reason: "stalled" as const, url: null };
const base: ReviewStallInput = {
  now,
  pullRequest: { draft: false, baseRef: "develop", headSha: "abc" },
  reviewStopped: stalled,
  reviewedSha: null,
  record: null,
};
const retried = {
  headSha: "abc",
  headAttempts: 1,
  totalAttempts: 1,
  lastAttemptAt: new Date(now.getTime() - REVIEW_STALL_NOTIFY_GRACE_MS - 1000),
  notifiedHeadSha: null,
};

describe("decideReviewStallRescue", () => {
  it("取り残されたPRは、まず1回やり直す", () => {
    expect(decideReviewStallRescue(base)).toEqual({ action: "retry" });
  });

  it("取り残し以外・下書き・develop向け以外・判定済みのコミットは触らない", () => {
    expect(decideReviewStallRescue({ ...base, reviewStopped: null }).action).toBe("skip");
    expect(decideReviewStallRescue({ ...base, reviewStopped: { ...stalled, reason: "failed" } }).action).toBe("skip");
    expect(decideReviewStallRescue({ ...base, pullRequest: { ...base.pullRequest, draft: true } }).action).toBe("skip");
    expect(decideReviewStallRescue({ ...base, pullRequest: { ...base.pullRequest, baseRef: "main" } }).action).toBe("skip");
    expect(decideReviewStallRescue({ ...base, reviewedSha: "abc" })).toEqual({ action: "skip", reason: "already_reviewed" });
  });

  it("同じコミットは2回起動せず、猶予の後に通知する", () => {
    const within = { ...retried, lastAttemptAt: new Date(now.getTime() - 1000) };
    expect(decideReviewStallRescue({ ...base, record: within })).toEqual({ action: "skip", reason: "within_grace" });
    expect(decideReviewStallRescue({ ...base, record: retried })).toEqual({ action: "notify" });
  });

  it("通知は同じコミットで1回だけ", () => {
    expect(decideReviewStallRescue({ ...base, record: { ...retried, notifiedHeadSha: "abc" } })).toEqual({
      action: "skip",
      reason: "already_notified",
    });
  });

  it("新しいコミットはやり直すが、PR全体の上限に達したら起動せず通知する", () => {
    const old = { ...retried, headSha: "old", notifiedHeadSha: "old" };
    expect(decideReviewStallRescue({ ...base, record: old })).toEqual({ action: "retry" });
    const exhausted = { ...old, totalAttempts: REVIEW_STALL_MAX_ATTEMPTS_PER_PULL_REQUEST, lastAttemptAt: new Date(now.getTime() - 1000) };
    expect(decideReviewStallRescue({ ...base, record: exhausted })).toEqual({ action: "notify" });
  });
});

describe("buildReviewStallPushPayload", () => {
  it("PR詳細を開き、下書きのまま残ったときは文言を変える", () => {
    const params = { repositoryFullName: "o/r", pullRequestNumber: 5, pullRequestTitle: "題", leftAsDraft: false };
    const payload = buildReviewStallPushPayload(params);
    expect(payload.title).toBe("r ・ 自動レビューが止まっています");
    expect(payload.body).toBe("#5 題");
    expect(payload.url).toContain("pane=pull-requests");
    expect(buildReviewStallPushPayload({ ...params, leftAsDraft: true }).title).toBe("r ・ PRが下書きのままです");
  });
});

describe("runReviewStallRescueSweep", () => {
  const pullRequest = { number: 5, title: "題", body: null, draft: false, base: { ref: "develop" }, head: { sha: "abc" } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repositoryFindMany.mockResolvedValue([
      { id: "r1", installationId: "i1", fullName: "o/r", ownerLogin: "o", name: "r", installation: { installationId: 1 } },
    ]);
    mocks.fetchOpenPullRequests.mockResolvedValue([pullRequest]);
    mocks.fetchPullRequestRollups.mockResolvedValue(
      new Map([["o/r#5", { rollup: { mergeJudgement: { reviewStopped: stalled } } }]]),
    );
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.pushFindMany.mockResolvedValue([{ id: "s" }]);
    mocks.rerunPullRequestReview.mockResolvedValue({ ok: true, method: "restart" });
  });

  it("回数を記録してからやり直す", async () => {
    const result = await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.rerunPullRequestReview.mock.invocationCallOrder[0]);
    expect(mocks.rerunPullRequestReview).toHaveBeenCalledWith(expect.objectContaining({ owner: "o", repo: "r", number: 5, headSha: "abc" }));
    expect(result.retried).toEqual([{ repositoryFullName: "o/r", pullRequestNumber: 5 }]);
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });

  it("別の巡回に席を取られたらやり直さない", async () => {
    mocks.create.mockRejectedValue(new Error("P2002"));
    const result = await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.rerunPullRequestReview).not.toHaveBeenCalled();
    expect(result.retried).toEqual([]);
  });

  it("上限の後は起動せず通知する", async () => {
    mocks.findUnique.mockResolvedValue(retried);
    const result = await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.rerunPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.sendPushNotification).toHaveBeenCalledWith([{ id: "s" }], expect.objectContaining({ title: "r ・ 自動レビューが止まっています" }));
    expect(result.notified).toHaveLength(1);
  });

  it("通知の席を取れなければ送らない", async () => {
    mocks.findUnique.mockResolvedValue(retried);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });

  it("レビュー可能へ戻せなかったら、その場で下書きのまま残ったことを知らせる", async () => {
    mocks.rerunPullRequestReview.mockResolvedValue({ ok: false, kind: "failed", code: "ready_failed" });
    const result = await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.sendPushNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "r ・ PRが下書きのままです" }));
    expect(result.notified).toHaveLength(1);
  });

  it("やり直しが例外で落ちても巡回を止めず、すぐには通知しない", async () => {
    mocks.rerunPullRequestReview.mockRejectedValue(new Error("boom"));
    const result = await runReviewStallRescueSweep({ force: true, now });
    expect(result).toMatchObject({ swept: true, retried: [], notified: [] });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });

  it("止まっていないPRの記録は読まず、閉じたPRの記録は消す", async () => {
    mocks.fetchPullRequestRollups.mockResolvedValue(new Map([["o/r#5", { rollup: { mergeJudgement: {} } }]]));
    await runReviewStallRescueSweep({ force: true, now });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { repositoryFullName: "o/r", pullRequestNumber: { notIn: [5] } } });
  });

  it("間隔に達していなければ巡回しない", async () => {
    await runReviewStallRescueSweep({ force: true, now });
    mocks.repositoryFindMany.mockClear();
    const result = await runReviewStallRescueSweep({ now: new Date(now.getTime() + 1000) });
    expect(result.swept).toBe(false);
    expect(mocks.repositoryFindMany).not.toHaveBeenCalled();
  });

  /** #5326。予約したまま止まった自動マージを、`auto-merge`ジョブの再実行で拾い直す */
  describe("予約したまま止まった自動マージ", () => {
    const judgedAt = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
    const stuckRollup = {
      rollup: { state: "success", mergeJudgement: { state: "settled", autoMergeRun: { url: null, completedAt: judgedAt } } },
    };

    beforeEach(() => {
      resetReviewStallRescueIntervalForTest();
      mocks.fetchOpenPullRequests.mockResolvedValue([{ ...pullRequest, auto_merge: { merge_method: "merge" } }]);
      mocks.fetchPullRequestRollups.mockResolvedValue(new Map([["o/r#5", stuckRollup]]));
      mocks.rerunPullRequestAutoMerge.mockResolvedValue({ ok: true, runId: 1, jobId: 2 });
    });

    it("同じHEADでは1回だけ、auto-mergeジョブをやり直す", async () => {
      const first = await runReviewStallRescueSweep({ force: true, now });
      expect(mocks.rerunPullRequestAutoMerge).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "o", repo: "r", number: 5, headSha: "abc" }),
      );
      expect(first.autoMergeRerun).toEqual([{ repositoryFullName: "o/r", pullRequestNumber: 5 }]);
      expect(mocks.rerunPullRequestReview).not.toHaveBeenCalled();

      const second = await runReviewStallRescueSweep({ force: true, now });
      expect(mocks.rerunPullRequestAutoMerge).toHaveBeenCalledTimes(1);
      expect(second.autoMergeRerun).toEqual([]);
    });

    it("予約していないPRには触らない", async () => {
      mocks.fetchOpenPullRequests.mockResolvedValue([{ ...pullRequest, auto_merge: null }]);
      await runReviewStallRescueSweep({ force: true, now });
      expect(mocks.rerunPullRequestAutoMerge).not.toHaveBeenCalled();
    });

    it("やり直しが例外で落ちても巡回を止めない", async () => {
      mocks.rerunPullRequestAutoMerge.mockRejectedValue(new Error("boom"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runReviewStallRescueSweep({ force: true, now });
      expect(result).toMatchObject({ swept: true, autoMergeRerun: [] });
      error.mockRestore();
    });
  });
});
